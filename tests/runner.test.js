import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../extension/runner.js';
import { newJob } from '../extension/core.js';

const photo = (path, extra = {}) => ({ type: 'file', name: path.split('/').pop(), path, size: 3, media_type: 'image', ...extra });
const dir = (name, items, offset = 0, total = items.length) => ({ type: 'dir', name, _embedded: { items, offset, total } });
const duplicatePhotos = () => [photo('/a.JPG', { sha256: 'a'.repeat(64), modified: '2026-01-01' }),
  photo('/a (1).JPG', { sha256: 'a'.repeat(64), modified: '2026-02-01' })];
function harness(overrides = {}) {
  let saved = null;
  const calls = [], savedFiles = [], removed = [], history = new Map(), items = new Map();
  const runner = createRunner({
    loadJob: async () => null,
    saveJob: async job => { saved = structuredClone(job); },
    loadHistory: async key => structuredClone(history.get(key) || {}),
    saveHistory: async (key, value) => { history.set(key, structuredClone(value)); },
    resource: async (job, path, offset) => { calls.push([path, offset]); return dir('Album', [photo('/a.JPG')]); },
    getPhoto: async () => new Blob(['abc'], { type: 'image/jpeg' }),
    downloads: {
      download: async args => { savedFiles.push(args); const id = savedFiles.length; items.set(id, { id, state: 'complete', exists: true, fileSize: 3, filename: args.filename }); return id; },
      search: async ({ id }) => items.has(id) ? [items.get(id)] : [],
      cancel: async () => {},
      removeFile: async id => { removed.push(id); items.get(id).exists = false; }
    },
    sleep: async () => {}, ...overrides
  });
  return { runner, calls, savedFiles, removed, history, items, saved: () => saved };
}

test('default downloads distinct identical source entries, but never repeats saved downloads', async () => {
  const h = harness({ resource: async () => dir('Album', duplicatePhotos()) });
  for (let n = 0; n < 2; n++) {
    await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
    assert.equal(h.savedFiles.length, 2);
    assert.equal((await h.runner.command('status')).job.summary.newFiles, n === 0 ? 2 : 0);
  }
  assert.equal(h.saved().deduplicate, false);
  assert.equal(h.saved().files.filter(f => f.reused).length, 2);
});

test('new-file counter excludes existing originals, previews, skips and failed writes; retries reset it', async () => {
  const originals = new Set(['/existing.JPG']), previews = new Set(['/old-preview.JPG']);
  let allAvailable = false;
  const items = ['existing.JPG', 'old-preview.JPG', 'new.JPG', 'new-preview.JPG', 'failed.JPG', 'empty.JPG'];
  const h = harness({
    resource: async () => dir('Album', items.map(name => photo('/' + name, { size: name === 'empty.JPG' ? 0 : 3 }))),
    findLocal: async (_job, file) => ({ original: originals.has(file.path) ? { savedKind: 'original', savedBytes: 3, localFile: true } : null,
      preview: previews.has(file.path) ? { savedKind: 'preview', savedBytes: 3, localFile: true } : null }),
    getPhoto: async (_job, file, kind) => {
      if (!allAvailable && kind === 'original' && file.name.includes('preview')) throw new Error('Original unavailable');
      return new Blob(['abc'], { type: 'image/jpeg' });
    },
    saveLocal: async (path, _source, options) => {
      if (!allAvailable && path.endsWith('/failed.JPG')) throw new Error('Write failed');
      const preview = path.includes('.preview.');
      (preview ? previews : originals).add('/' + path.split('/').at(-1).replace('.preview.jpg', '.JPG'));
      return { savedPath: path, savedBytes: options.expectedSize, localFile: true };
    }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  let s = (await h.runner.command('status')).job.summary;
  assert.equal(s.newFiles, 2); assert.equal(s.failed, 1); assert.equal(s.skipped, 1); assert.equal(s.reused, 2);
  allAvailable = true;
  await h.runner.command('retry', { includePreviews: true }); await h.runner.waitUntilIdle();
  s = (await h.runner.command('status')).job.summary;
  assert.equal(s.newFiles, 3); assert.equal(s.failed, 0); assert.equal(s.previews, 0);
  await h.runner.command('retry', { includePreviews: true }); await h.runner.waitUntilIdle();
  assert.equal((await h.runner.command('status')).job.summary.newFiles, 0);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert.equal((await h.runner.command('status')).job.summary.newFiles, 0);
});

test('new-file counter survives pause and reload, then continues in the same run', async () => {
  let saved, blocked = false, blockSecond = true;
  const deps = {
    loadJob: async () => saved && structuredClone(saved), saveJob: async job => { saved = structuredClone(job); },
    resource: async () => dir('Album', [photo('/first.JPG'), photo('/second.JPG')]),
    getPhoto: async (_job, file, _kind, signal) => {
      if (file.name === 'second.JPG' && blockSecond) {
        blocked = true;
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return new Blob(['abc'], { type: 'image/jpeg' });
    },
    saveLocal: async (path, _source, options) => ({ savedPath: path, savedBytes: options.expectedSize, localFile: true })
  };
  const runner = createRunner(deps);
  await runner.command('scan', { link: 'https://disk.yandex.ru/d/test' });
  for (let n = 0; n < 100 && !blocked; n++) await new Promise(resolve => setTimeout(resolve, 0));
  assert(blocked); assert.equal((await runner.command('status')).job.summary.newFiles, 1);
  await runner.command('pause'); await runner.waitUntilIdle();
  blockSecond = false;
  const restored = createRunner(deps); await restored.ready;
  assert.equal((await restored.command('status')).job.summary.newFiles, 1);
  await restored.command('start'); await restored.waitUntilIdle();
  assert.equal((await restored.command('status')).job.summary.newFiles, 2);
});

test('optional SHA256 dedup reuses same-folder contents despite different names and dates; disabling it fills missing entries', async () => {
  const h = harness({ resource: async () => dir('Album', duplicatePhotos()) });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', deduplicate: true }); await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 1);
  assert.equal(h.saved().files.filter(f => f.reused).length, 1);
  // Simulate browser restart: recovery must not turn the alias into an own-file receipt.
  const recovered = createRunner({ loadJob: async () => h.saved(), saveJob: async () => {},
    loadHistory: async key => structuredClone(h.history.get(key) || {}),
    saveHistory: async (key, value) => h.history.set(key, structuredClone(value)), downloads: {} });
  await recovered.ready;
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', deduplicate: false }); await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 2);
  assert.match(h.savedFiles[1].filename, /a \(1\)\.JPG$/);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 2);
});

test('optional dedup never merges different directories or files lacking a reliable checksum', async () => {
  const h = harness({ resource: async (_job, path) => path === '/' ? dir('Album', [
    photo('/a.JPG'), photo('/b.JPG'), photo('/hashed.JPG', { sha256: 'a'.repeat(64) }),
    { type: 'dir', name: 'Sub', path: '/Sub' }
  ]) : dir('Sub', [photo('/Sub/hashed.JPG', { sha256: 'a'.repeat(64) })]) });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', deduplicate: true }); await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 4);
});

test('optional dedup does not reuse a removed file and can upgrade a shared preview', async () => {
  const h = harness({ resource: async () => dir('Album', duplicatePhotos()) });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', deduplicate: true, mode: 'preview' }); await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 1);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', deduplicate: true }); await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 2); assert.deepEqual(h.removed, [1]);
  h.items.get(2).exists = false;
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', deduplicate: true }); await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 3);
});

test('nested URL preserves root album and every parent, paginates and recurses without popup polling', async () => {
  const calls = [];
  const h = harness({ resource: async (_job, path, offset) => {
    calls.push([path, offset]);
    if (path === '/') return dir('Family Album', []);
    if (path === '/0 лет/Выписка/retouch/deeper') return dir('deeper', [photo(path + '/b.JPG')]);
    if (offset === 0) return dir('retouch', [photo(path + '/a.JPG')], 0, 2);
    return dir('retouch', [{ type: 'dir', name: 'deeper', path: path + '/deeper' }], 1, 2);
  }});
  const state = await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test/0%20лет/Выписка/retouch' });
  assert.equal(state.running, true);
  // No UI status requests: work must complete independently of the popup.
  await h.runner.waitUntilIdle();
  assert.deepEqual(calls, [['/', 0], ['/0 лет/Выписка/retouch', 0], ['/0 лет/Выписка/retouch', 1], ['/0 лет/Выписка/retouch/deeper', 0]]);
  assert.deepEqual(h.savedFiles.map(f => f.filename), [
    'yandex-disk/Family Album/0 лет/Выписка/retouch/a.JPG',
    'yandex-disk/Family Album/0 лет/Выписка/retouch/deeper/b.JPG'
  ]);
  assert(h.savedFiles.every(f => f.saveAs === false));
  assert.equal(h.saved().phase, 'done');
});

test('nested single file goes into its parent folder, not a folder named after the photo', async () => {
  const h = harness({ resource: async (_job, path) => path === '/' ? dir('Album', []) : photo(path) });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test/Folder/a.JPG' });
  await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles[0].filename, 'yandex-disk/Album/Folder/a.JPG');
});

test('three failed photo originals switch photos to previews; video still attempts original and errors do not stop queue', async () => {
  const attempts = [];
  const h = harness({
    resource: async () => dir('Album', [1,2,3,4,5].map(n => photo('/' + n + '.JPG')).concat(photo('/v.mp4', { media_type: 'video' }))),
    getPhoto: async (_job, file, kind) => {
      attempts.push([file.name, kind]);
      if (kind === 'original' || file.name === '4.JPG') throw new Error('Unavailable');
      return new Blob(['abc'], { type: 'image/jpeg' });
    }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'auto' });
  await h.runner.waitUntilIdle();
  assert.equal(attempts.filter(a => a[1] === 'original' && a[0] !== 'v.mp4').length, 3);
  assert(attempts.some(a => a[0] === 'v.mp4' && a[1] === 'original'));
  assert.equal(h.savedFiles.length, 4);
  const s = (await h.runner.command('status')).job.summary;
  assert.equal(s.previews, 4); assert.equal(s.failed, 2); assert.equal(s.skipped, 0);
});

test('pause aborts in-flight fetch and leaves file pending for explicit resume', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  const h = harness({ getPhoto: async (_job, _file, _kind, signal) => {
    if (first) { first = false; entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    return new Blob(['abc'], { type: 'image/jpeg' });
  }});
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' });
  await started;
  await h.runner.command('pause');
  await h.runner.waitUntilIdle();
  assert.equal(h.saved().files[0].state, 'pending');
  assert.equal(h.savedFiles.length, 0);
  await h.runner.command('start');
  await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 1);
});

test('HTTP 429 pauses queue rather than skipping whole album', async () => {
  const h = harness({ getPhoto: async () => { throw Object.assign(new Error('Rate limit'), { status: 429 }); } });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' });
  await h.runner.waitUntilIdle();
  assert.equal(h.saved().files[0].state, 'pending');
  assert.equal(h.saved().phase, 'downloading');
  assert.match((await h.runner.command('status')).notice, /Rate limit/);
});

test('retry recovers unread directory and keeps already saved photos', async () => {
  let attempt = 0;
  const h = harness({ resource: async (_job, path) => {
    if (path === '/') return dir('Album', [photo('/a.JPG'), { type: 'dir', name: 'sub', path: '/sub' }]);
    if (++attempt === 1) throw new Error('HTTP 503');
    return dir('sub', [photo('/sub/b.JPG')]);
  }});
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' });
  await h.runner.waitUntilIdle();
  assert.equal((await h.runner.command('status')).job.summary.directoriesFailed, 1);
  await h.runner.command('retry');
  await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 2);
  assert.equal((await h.runner.command('status')).job.summary.directoriesFailed, 0);
});

test('retry includes previews only when requested, without rescanning or repeating originals', async () => {
  let available = false, scans = 0;
  const attempts = [];
  const h = harness({
    resource: async () => { scans++; return dir('Album', [photo('/original.JPG'), photo('/copy.JPG'), photo('/error.JPG')]); },
    getPhoto: async (_job, file, kind) => {
      attempts.push([file.name, kind]);
      if (!available && (file.name === 'error.JPG' || (file.name === 'copy.JPG' && kind === 'original'))) throw new Error('Unavailable');
      return new Blob(['abc'], { type: 'image/jpeg' });
    }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  attempts.length = 0; available = true;
  await h.runner.command('retry'); await h.runner.waitUntilIdle();
  assert.deepEqual(attempts, [['error.JPG', 'original']]);
  attempts.length = 0;
  await h.runner.command('retry', { includePreviews: true }); await h.runner.waitUntilIdle();
  assert.deepEqual(attempts, [['copy.JPG', 'original']]);
  assert.equal(scans, 1);
  assert.deepEqual(h.removed, [2]);
  assert.equal((await h.runner.command('status')).job.summary.originals, 3);
  await h.runner.command('retry', { includePreviews: true }); await h.runner.waitUntilIdle();
  assert.equal(attempts.length, 1);
});

for (const mode of ['auto', 'preview']) test(`preview retry preserves unavailable copies and retries every original in ${mode} mode`, async () => {
  let available = false;
  const attempts = [];
  const h = harness({
    resource: async () => dir('Album', [1, 2, 3, 4].map(n => photo('/' + n + '.JPG'))),
    getPhoto: async (_job, file, kind) => {
      attempts.push([file.name, kind]);
      if (!available && kind === 'original') throw new Error('Unavailable');
      return new Blob(['abc'], { type: 'image/jpeg' });
    }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode }); await h.runner.waitUntilIdle();
  attempts.length = 0;
  await h.runner.command('retry', { includePreviews: true }); await h.runner.waitUntilIdle();
  assert.equal(attempts.length, 4);
  assert(attempts.every(([, kind]) => kind === 'original'));
  assert.equal(h.savedFiles.length, 4); assert.deepEqual(h.removed, []);
  assert.equal((await h.runner.command('status')).job.summary.previews, 4);
  available = true;
  await h.runner.command('retry', { includePreviews: true }); await h.runner.waitUntilIdle();
  assert.equal((await h.runner.command('status')).job.summary.originals, 4);
  assert.equal(h.removed.length, 4);
});

test('restart reconciles saved Chrome download without re-downloading', async () => {
  const job = newJob('https://disk.yandex.ru/d/test');
  job.files = [{ path: '/a.JPG', name: 'a.JPG', kind: 'photo', state: 'active', downloadId: 7, savedBytes: 3 }];
  const h = harness({ loadJob: async () => job, downloads: { search: async () => [{ state: 'complete', fileSize: 3, filename: 'saved/a.JPG' }] } });
  await h.runner.ready;
  assert.equal(h.saved().files[0].state, 'done');
  assert.equal(h.savedFiles.length, 0);
});

test('fresh scan upgrades existing preview then removes it only after verified original; next scan reuses original', async () => {
  const h = harness();
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'preview' });
  await h.runner.waitUntilIdle();
  assert.match(h.savedFiles[0].filename, /\.preview\.jpg$/);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'auto' });
  await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 2);
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.items.get(2).exists, true);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'auto' });
  await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 2);
  assert.equal((await h.runner.command('status')).job.summary.reused, 1);
});

test('unavailable original preserves preview without downloading a duplicate', async () => {
  const h = harness({ getPhoto: async (_job, _file, kind) => {
    if (kind === 'original') throw new Error('Unavailable');
    return new Blob(['abc'], { type: 'image/jpeg' });
  }});
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'preview' });
  await h.runner.waitUntilIdle();
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'auto' });
  await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 1); assert.deepEqual(h.removed, []);
  assert.equal(h.items.get(1).exists, true);
  assert.equal(h.saved().files[0].savedKind, 'preview');
});

test('size mismatch after Chrome save never deletes an existing preview', async () => {
  const h = harness({ getPhoto: async (_job, _file, kind) => new Blob([kind === 'original' ? 'different size' : 'abc'], { type: 'image/jpeg' }) });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'preview' });
  await h.runner.waitUntilIdle();
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'auto' });
  await h.runner.waitUntilIdle();
  assert.equal(h.saved().files[0].state, 'failed');
  assert.equal(h.items.get(1).exists, true); assert.deepEqual(h.removed, []);
});

test('missing or changed saved original is downloaded again', async () => {
  let modified = '2026-01-01';
  const h = harness({ resource: async () => dir('Album', [photo('/a.JPG', { modified })]) });
  for (let n = 0; n < 3; n++) {
    await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
    if (n === 0) h.items.get(1).exists = false;
    if (n === 1) modified = '2026-02-01';
  }
  assert.equal(h.savedFiles.length, 3);
});

test('stop cancels active fetch, preserves saved history, and allows a fresh scan', async () => {
  let enter, first = true;
  const entered = new Promise(resolve => { enter = resolve; });
  const h = harness({ getPhoto: async (_job, _file, _kind, signal) => {
    if (first) { first = false; enter(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    return new Blob(['abc'], { type: 'image/jpeg' });
  }});
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await entered;
  await h.runner.command('stop'); await h.runner.waitUntilIdle();
  assert.equal(h.saved().phase, 'stopped');
  await assert.rejects(h.runner.command('start'), /остановлено/);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert.equal(h.savedFiles.length, 1);
});

test('large videos and text documents use native download; no image preview or memory limit applies', async () => {
  const files = [photo('/video.mp4', { media_type: 'video', size: 800 * 1048576 }), photo('/notes.txt', { media_type: 'document', mime_type: 'text/plain', size: 123 })];
  const downloads = [];
  const h = harness({
    resource: async () => dir('Album', files),
    getPhoto: async () => { throw new Error('Image fetch must not be used'); },
    getOriginalUrl: async (_job, file) => 'https://downloader.disk.yandex.ru/disk/' + file.name,
    downloads: {
      download: async args => { downloads.push(args); return downloads.length; },
      search: async ({ id }) => [{ id, state: 'complete', exists: true, fileSize: files[id - 1].size, filename: downloads[id - 1].filename }], cancel: async () => {}
    }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'preview' }); await h.runner.waitUntilIdle();
  assert.equal(downloads.length, 2);
  assert.equal(h.saved().files.filter(f => f.state === 'done').length, 2);
  assert(downloads.every(d => d.url.startsWith('https:') && !d.filename.includes('.preview')));
});

test('native download without bytes times out after 25 seconds and is cancelled', async () => {
  let time = 0, cancelled = false;
  const h = harness({
    resource: async () => dir('Album', [photo('/video.mp4', { media_type: 'video' })]),
    getOriginalUrl: async () => 'https://downloader.disk.yandex.ru/disk/video',
    now: () => time, sleep: async ms => { time += ms; },
    downloads: { download: async () => 1, search: async () => [{ state: 'in_progress', bytesReceived: 0 }], cancel: async () => { cancelled = true; } }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert(cancelled); assert(time >= 25000 && time < 26000);
  assert.equal(h.saved().files[0].state, 'failed'); assert.match(h.saved().files[0].reason, /25 с\./);
});

test('photos from every nested folder precede videos and documents, including a restored queue', async () => {
  const h = harness({ resource: async (_job, path) => path === '/' ? dir('Album', [
    photo('/a.mov', { media_type: 'video' }), photo('/b.pdf', { media_type: 'document' }), photo('/c.JPG'),
    { type: 'dir', name: 'Sub', path: '/Sub' }
  ]) : dir('Sub', [photo('/Sub/a.mov', { media_type: 'video' }), photo('/Sub/b.JPG')]) });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', download: false }); await h.runner.waitUntilIdle();
  const saved = h.saved(), order = [], passes = [];
  const restored = harness({ loadJob: async () => saved, getPhoto: async (_job, file) => {
    order.push(file.path); passes.push((await restored.runner.command('status')).job.pass);
    return new Blob(['abc'], { type: 'image/jpeg' });
  }});
  await restored.runner.command('start'); await restored.runner.waitUntilIdle();
  assert.deepEqual(order, ['/c.JPG', '/Sub/b.JPG', '/a.mov', '/b.pdf', '/Sub/a.mov']);
  assert.deepEqual(passes, ['photos', 'photos', 'other', 'other', 'other']);
  assert.equal(restored.saved().files.filter(f => f.state === 'done').length, 5);
});

test('a hung native start expires, next file proceeds, and a late download ID is cancelled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let enter, late, starts = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const cancelled = [], names = new Map();
  const h = harness({
    resource: async () => dir('Album', [photo('/a.mov', { media_type: 'video' }), photo('/b.mov', { media_type: 'video' })]),
    getOriginalUrl: async (_job, file) => 'https://downloader.disk.yandex.ru/disk/' + file.name,
    downloads: {
      download: args => {
        starts++; names.set(starts, args.filename);
        if (starts === 1) { enter(); return new Promise(resolve => { late = resolve; }); }
        return Promise.resolve(starts);
      },
      search: async ({ id }) => [{ id, state: 'complete', exists: true, fileSize: 3, filename: names.get(id) }],
      cancel: async id => { cancelled.push(id); }
    }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await entered;
  assert.match((await h.runner.command('status')).current, /ожидаем начала/);
  t.mock.timers.tick(25000); await h.runner.waitUntilIdle();
  assert.equal(h.saved().files[0].state, 'failed');
  assert.match(h.saved().files[0].reason, /не подтвердил начало/);
  assert.equal(h.saved().files[1].state, 'done');
  assert.equal(starts, 2);
  late(1); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cancelled, [1]);
});

test('pause interrupts pending native start immediately and cancels its eventual ID', async () => {
  let enter, late;
  const entered = new Promise(resolve => { enter = resolve; }), cancelled = [];
  const h = harness({
    resource: async () => dir('Album', [photo('/a.mov', { media_type: 'video' })]),
    getOriginalUrl: async () => 'https://downloader.disk.yandex.ru/disk/video',
    downloads: { download: () => { enter(); return new Promise(resolve => { late = resolve; }); }, cancel: async id => { cancelled.push(id); } }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await entered;
  await h.runner.command('pause'); await h.runner.waitUntilIdle();
  assert.equal(h.saved().files[0].state, 'pending');
  assert.equal((await h.runner.command('status')).running, false);
  late(42); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cancelled, [42]);
});

test('stop interrupts pending native start, preserves pending work and prevents automatic continuation', async () => {
  let enter, late;
  const entered = new Promise(resolve => { enter = resolve; }), cancelled = [];
  const h = harness({
    resource: async () => dir('Album', [photo('/a.mov', { media_type: 'video' })]),
    getOriginalUrl: async () => 'https://downloader.disk.yandex.ru/disk/video',
    downloads: { download: () => { enter(); return new Promise(resolve => { late = resolve; }); }, cancel: async id => { cancelled.push(id); } }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await entered;
  await h.runner.command('stop'); await h.runner.waitUntilIdle();
  assert.equal(h.saved().phase, 'stopped'); assert.equal(h.saved().files[0].state, 'pending');
  await assert.rejects(h.runner.command('start'), /остановлено/);
  late(42); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cancelled, [42]);
});

test('a hung browser status call expires and does not block the queue during cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let enter, cancelStarted;
  const entered = new Promise(resolve => { enter = resolve; });
  const cancelling = new Promise(resolve => { cancelStarted = resolve; });
  const h = harness({
    resource: async () => dir('Album', [photo('/a.mov', { media_type: 'video' })]),
    getOriginalUrl: async () => 'https://downloader.disk.yandex.ru/disk/video',
    downloads: { download: async () => 1,
      search: () => { enter(); return new Promise(() => {}); },
      cancel: () => { cancelStarted(); return new Promise(() => {}); } }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await entered;
  t.mock.timers.tick(10000); await cancelling;
  t.mock.timers.tick(5000); await h.runner.waitUntilIdle();
  assert.equal(h.saved().files[0].state, 'failed');
  assert.match(h.saved().files[0].reason, /не ответил за 10 секунд/);
});

test('a large native video is allowed to continue while bytes keep arriving', async () => {
  let time = 0, filename, cancelled = false;
  const h = harness({
    resource: async () => dir('Album', [photo('/video.mov', { media_type: 'video', size: 1000000 })]),
    getOriginalUrl: async () => 'https://downloader.disk.yandex.ru/disk/video',
    now: () => time, sleep: async ms => { time += ms; },
    downloads: {
      download: async args => { filename = args.filename; return 1; },
      search: async () => [time >= 600000
        ? { state: 'complete', exists: true, fileSize: 1000000, filename }
        : { state: 'in_progress', bytesReceived: Math.floor(time / 20000) * 1000 }],
      cancel: async () => { cancelled = true; }
    }
  });
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert(time >= 600000); assert.equal(cancelled, false); assert.equal(h.saved().files[0].state, 'done');
});
