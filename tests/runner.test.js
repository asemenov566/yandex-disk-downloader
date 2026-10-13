import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../extension/runner.js';
import { newJob } from '../extension/core.js';

const photo = (path, extra = {}) => ({ type: 'file', name: path.split('/').pop(), path, size: 3, media_type: 'image', ...extra });
const dir = (name, items, offset = 0, total = items.length) => ({ type: 'dir', name, _embedded: { items, offset, total } });
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
  assert.equal(h.saved().files[0].state, 'failed'); assert.match(h.saved().files[0].reason, /25 секунд/);
});
