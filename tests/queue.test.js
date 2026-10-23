import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../extension/queue.js';
import { newJob, outputPath } from '../extension/core.js';
import { overallProgress } from '../extension/progress.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await tick(); } throw new Error('Condition not reached'); }
function setup(concurrency, downloadLimit = 50) {
  const entered = [], gates = [], saved = new Map(), files = [], scans = [], kinds = [], failures = new Set();
  const queue = createQueue({
    concurrency, loadSettings: async () => ({ downloadLimit }), loadEntries: async () => [],
    saveEntry: async entry => { saved.set(entry.id, structuredClone(entry)); }, deleteEntry: async id => { saved.delete(id); },
    resource: async job => { scans.push(job.publicUrl); return { type: 'dir', name: job.publicUrl.split('/').pop(), _embedded: { total: 1, offset: 0,
      items: [{ type: 'file', name: 'a.JPG', path: job.path === '/' ? '/a.JPG' : job.path + '/a.JPG', size: 3, media_type: 'image' }] } }; },
    getPhoto: async (job, _file, kind, signal) => {
      entered.push(job.publicUrl + job.path);
      kinds.push(kind);
      await new Promise((resolve, reject) => { gates.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      if (failures.has(job.publicUrl)) throw new Error('Unavailable');
      return new Blob(['abc'], { type: 'image/jpeg' });
    },
    downloads: {
      download: async args => { files.push(args); return files.length; },
      search: async ({ id }) => [{ id, state: 'complete', exists: true, fileSize: 3, filename: files[id - 1].filename }], cancel: async () => {}
    }, sleep: async () => {}
  });
  return { queue, entered, gates, saved, files, scans, kinds, failures };
}

test('retry all targets completed errors, includes previews only when selected, and does not rescan', async () => {
  const h = setup(1);
  h.failures.add('https://disk.yandex.ru/d/bad');
  for (const [name, mode] of [['good', 'original'], ['bad', 'original'], ['preview', 'preview']]) {
    const count = h.gates.length;
    await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/' + name, mode });
    await until(() => h.gates.length === count + 1); h.gates[count](); await h.queue.waitUntilIdle();
  }
  const active = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/active' });
  await until(() => h.gates.length === 4);
  h.failures.clear();
  const retry = await h.queue.command('retryAll', { id: active.id });
  assert.equal(retry.id, active.id);
  assert.equal(retry.jobs.filter(j => j.queued).length, 1);
  assert(retry.jobs.find(j => j.publicUrl.endsWith('/preview')).completed);
  assert.equal(overallProgress(retry.jobs).newFiles, 0);
  assert.equal(retry.jobs.find(j => j.publicUrl.endsWith('/good')).summary.newFiles, 1);
  h.gates[3](); await until(() => h.gates.length === 5); h.gates[4](); await h.queue.waitUntilIdle();
  assert.equal(h.scans.length, 4);
  await h.queue.command('retryAll', { includePreviews: true });
  await until(() => h.gates.length === 6); h.gates[5](); await h.queue.waitUntilIdle();
  assert.equal(h.kinds[5], 'original'); assert.equal(h.scans.length, 4);
  assert.equal(h.entered.filter(url => url.endsWith('/good/')).length, 1);
  assert.equal(h.entered.filter(url => url.endsWith('/active/')).length, 1);
});

test('repeat all starts a common counter while another album keeps its individual run; restore preserves both', async () => {
  const old = newJob('https://disk.yandex.ru/d/completed');
  old.phase = 'done'; old.runNewFiles = 20;
  const active = newJob('https://disk.yandex.ru/d/active', 'original');
  active.phase = 'downloading'; active.title = 'Active'; active.folder = 'yandex-disk/Active';
  active.directories = []; active.runNewFiles = 606;
  active.files = [{ name: 'last.jpg', path: '/last.jpg', local: 'last.jpg', kind: 'photo', size: 3, state: 'pending' }];
  const saved = new Map([['old', { id: 'old', job: old }], ['active', { id: 'active', job: active }]]);
  const disk = new Map(), gates = [];
  let gate = true;
  const dependencies = {
    loadEntries: async () => structuredClone([...saved.values()]),
    saveEntry: async entry => saved.set(entry.id, structuredClone(entry)),
    resource: async () => ({ type: 'dir', name: 'Completed', _embedded: { total: 113, offset: 0,
      items: Array.from({ length: 113 }, (_, i) => ({ type: 'file', name: `${i}.jpg`, path: `/${i}.jpg`, size: 3, media_type: 'image' })) } }),
    getPhoto: async () => {
      if (gate) await new Promise(resolve => gates.push(resolve));
      return new Blob(['abc'], { type: 'image/jpeg' });
    },
    findLocal: async (job, file) => ({ original: disk.get(outputPath(job, file, 'original', '')) }),
    saveLocal: async path => {
      const record = { savedPath: path, savedBytes: 3, savedKind: 'original', localFile: true };
      disk.set(path, record); return record;
    }
  };
  const queue = createQueue(dependencies);
  await queue.command('start', { id: 'active' });
  await until(() => gates.length === 1);
  assert.equal(overallProgress((await queue.command('status')).jobs).newFiles, 626);
  const repeated = await queue.command('downloadAll');
  assert.equal(overallProgress(repeated.jobs).newFiles, 0);
  assert.equal(repeated.jobs.find(j => j.id === 'active').summary.newFiles, 606);
  gate = false; gates.forEach(resolve => resolve()); await queue.waitUntilIdle();
  const finished = await queue.command('status');
  // The old sum is 607 + 113 = 720; only 114 files were written after the click.
  assert.equal(finished.jobs.reduce((n, j) => n + j.summary.newFiles, 0), 720);
  assert.equal(overallProgress(finished.jobs).newFiles, 114);
  assert.equal(disk.size, 114);
  const restored = createQueue(dependencies);
  assert.equal(overallProgress((await restored.command('status')).jobs).newFiles, 114);
  const noTargets = await restored.command('retryAll');
  assert.equal(overallProgress(noTargets.jobs).newFiles, 114);
  await restored.command('downloadAll'); await restored.waitUntilIdle();
  assert.equal(overallProgress((await restored.command('status')).jobs).newFiles, 0);
  assert.equal(disk.size, 114);
});

test('download all rescans only completed albums, preserving ids, paths and per-album options', async () => {
  const h = setup(1), ids = [];
  for (const link of ['https://disk.yandex.ru/d/a/nested', 'https://disk.yandex.ru/d/b']) {
    const count = h.gates.length;
    ids.push((await h.queue.command('scan', { link, mode: 'original', deduplicate: true })).id);
    await until(() => h.gates.length === count + 1); h.gates[count](); await h.queue.waitUntilIdle();
  }
  const paused = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/paused' });
  await until(() => h.gates.length === 3); await h.queue.command('pause', { id: paused.id }); await h.queue.waitUntilIdle();
  const active = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/active' });
  await until(() => h.gates.length === 4);
  const before = h.scans.length;
  await h.queue.command('downloadAll', { includePreviews: true });
  h.gates[3](); await until(() => h.gates.length === 5); h.gates[4]();
  await until(() => h.gates.length === 6); h.gates[5](); await h.queue.waitUntilIdle();
  assert.equal(h.scans.length, before + 3); // Root title + nested directory, then album b.
  assert.equal(h.saved.get(ids[0]).job.path, '/nested');
  for (const id of ids) { assert.equal(h.saved.get(id).job.mode, 'original'); assert.equal(h.saved.get(id).job.deduplicate, true); }
  assert.equal(h.entered.filter(url => url.endsWith('/paused/')).length, 1);
  assert.equal(h.entered.filter(url => url.endsWith('/active/')).length, 1);
  assert.equal((await h.queue.command('status')).jobs.length, 4);
});

test('stop all cancels active and queued albums; resume all continues checkpoints without rescanning', async () => {
  const h = setup(1);
  const done = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/done' });
  await until(() => h.gates.length === 1); h.gates[0](); await h.queue.waitUntilIdle();
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/b' });
  await until(() => h.gates.length === 2);
  const stopped = await h.queue.command('stopAll', { id: a.id });
  assert.equal(stopped.id, a.id);
  assert(stopped.jobs.every(j => !j.running && !j.queued));
  assert.equal(stopped.jobs.filter(j => j.resumable).length, 2);
  assert.equal(stopped.jobs.find(j => j.id === done.id).phase, 'done');
  assert.equal(h.entered.length, 2); // The queued album was not started by cancellation.
  await h.queue.command('resumeAll');
  await until(() => h.gates.length === 3); h.gates[2]();
  await until(() => h.gates.length === 4); h.gates[3](); await h.queue.waitUntilIdle();
  assert.equal(h.scans.filter(url => url.endsWith('/a')).length, 1);
  assert.equal(h.files.length, 3);
  assert((await h.queue.command('status')).jobs.every(j => !j.resumable && j.phase === 'done'));
});

test('resume all includes paused and stopped tasks without restarting a running task', async () => {
  const h = setup(undefined, 1);
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await until(() => h.gates.length === 1);
  await h.queue.command('pause', { id: a.id }); await h.queue.waitUntilIdle();
  const b = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/b' });
  await until(() => h.gates.length === 2);
  await h.queue.command('stop', { id: b.id }); await h.queue.waitUntilIdle();
  const c = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/c' });
  await until(() => h.gates.length === 3);
  await h.queue.command('resumeAll', { id: c.id });
  h.gates[2](); await until(() => h.gates.length === 5);
  h.gates[3](); h.gates[4](); await h.queue.waitUntilIdle();
  assert.equal(h.entered.filter(url => url.endsWith('/c/')).length, 1);
  assert.equal(h.files.length, 3); assert.equal(h.scans.length, 3);
});

test('pause all preserves queued retry intent and resumes without restarting completed albums', async () => {
  const h = setup(1);
  const done = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/done' });
  await until(() => h.gates.length === 1); h.gates[0](); await h.queue.waitUntilIdle();
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await h.queue.command('retry', { id: done.id, includePreviews: true });
  await until(() => h.gates.length === 2);
  const paused = await h.queue.command('pauseAll');
  assert(paused.jobs.every(j => !j.running && !j.queued && j.phase !== 'stopped'));
  assert.equal(h.entered.length, 2);
  assert.equal(h.saved.get(done.id).suspendedRetry.includePreviews, true);
  await h.queue.command('resumeAll');
  await until(() => h.gates.length === 3); h.gates[2](); await h.queue.waitUntilIdle();
  assert.equal(h.scans.length, 2);
  assert.equal((await h.queue.command('status', { id: a.id })).job.summary.done, 1);
});

test('combined report saves all albums and errors to one CSV without modifying jobs', async () => {
  const jobs = ['first', 'second'].map(id => ({ id, wanted: false, job: {
    ...newJob('https://disk.yandex.ru/d/' + id), title: id === 'first' ? '=unsafe;"title"' : id,
    phase: 'done', files: [{ path: '/a.jpg', state: id === 'first' ? 'done' : 'failed', savedKind: 'preview', reason: 'error\nwith newline' }]
  } }));
  let saved, prepared = 0;
  const queue = createQueue({ loadEntries: async () => structuredClone(jobs), saveEntry: async () => {},
    prepareDownloads: async () => { prepared++; }, saveLocal: async (path, blob, options) => { saved = { path, text: await blob.text(), size: blob.size, options }; }
  });
  const result = await queue.command('reportAll');
  assert.equal(prepared, 1); assert.equal(result.jobs.length, 2);
  assert.match(saved.path, /^yandex-disk\/download-report-all-.*\.csv$/);
  assert.equal(saved.options.expectedSize, saved.size);
  assert(saved.text.includes('https://disk.yandex.ru/d/first'));
  assert(saved.text.includes('https://disk.yandex.ru/d/second'));
  assert(saved.text.includes('"\'=unsafe;""title"""'));
  assert(saved.text.includes('preview')); assert(saved.text.includes('failed'));
});
test('deleting an active row cancels it and cannot resurrect it after a checkpoint', async () => {
  const h = setup();
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await until(() => h.gates.length === 1);
  const result = await h.queue.command('delete', { id: a.id });
  await h.queue.waitUntilIdle();
  assert.equal(result.jobs.length, 0); assert.equal(result.job, null);
  assert.equal(h.saved.has(a.id), false); assert.equal(h.files.length, 0);
  const next = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  assert.notEqual(next.id, a.id);
  await until(() => h.gates.length === 2); h.gates[1](); await h.queue.waitUntilIdle();
  await h.queue.command('delete', { id: next.id });
  assert.equal(h.files.length, 1); assert.equal(h.saved.size, 0);
});

test('each job has its own file budget, even at a limit of one', async () => {
  const h = setup(undefined, 1);
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/b' });
  await until(() => h.gates.length === 2);
  assert.equal((await h.queue.command('status')).downloadLimit, 1);
  assert.equal((await h.queue.command('status')).activeDownloads, 2);
  await h.queue.command('settings', { downloadLimit: 5 });
  await until(() => h.gates.length === 2);
  await assert.rejects(h.queue.command('settings', { downloadLimit: 0 }));
  h.gates.forEach(resolve => resolve()); await h.queue.waitUntilIdle();
  assert.equal(h.files.length, 2);
});

test('changing folder is refused while any download is active', async () => {
  const h = setup();
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await until(() => h.gates.length === 1);
  await assert.rejects(h.queue.command('folder', { token: 'candidate' }), /приостановите/);
  await h.queue.command('pause', { id: a.id }); await h.queue.waitUntilIdle();
  await h.queue.command('folder', { token: 'candidate' });
  assert.equal(h.files.length, 0);
});

test('queued retry keeps preview option until a worker becomes available', async () => {
  const h = setup(1);
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a', mode: 'preview' });
  await until(() => h.gates.length === 1); h.gates[0](); await h.queue.waitUntilIdle();
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/b' });
  await until(() => h.gates.length === 2);
  const queued = await h.queue.command('retry', { id: a.id, includePreviews: true });
  assert.equal(queued.queued, true);
  assert.equal(queued.job.summary.newFiles, 0);
  h.gates[1](); await until(() => h.gates.length === 3);
  h.gates[2](); await h.queue.waitUntilIdle();
  assert.equal((await h.queue.command('status', { id: a.id })).job.summary.originals, 1);
  assert.equal(h.files.length, 3);
});

test('stop all preserves a queued retry of previews for resume all', async () => {
  const h = setup(1);
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a', mode: 'preview' });
  await until(() => h.gates.length === 1); h.gates[0](); await h.queue.waitUntilIdle();
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/b' });
  await until(() => h.gates.length === 2);
  await h.queue.command('retry', { id: a.id, includePreviews: true });
  await h.queue.command('stopAll');
  assert((await h.queue.command('status')).jobs.find(j => j.id === a.id).resumable);
  await h.queue.command('resumeAll');
  await until(() => h.gates.length === 3); h.gates[2]();
  await until(() => h.gates.length === 4); h.gates[3](); await h.queue.waitUntilIdle();
  assert.equal((await h.queue.command('status', { id: a.id })).job.summary.originals, 1);
  assert.equal(h.scans.filter(url => url.endsWith('/a')).length, 1);
});

test('two independent albums run concurrently; third waits; stopped queue does not start', async () => {
  const h = setup(2);
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/b' });
  const c = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/c' });
  await until(() => h.entered.length === 2);
  assert.equal(c.queued, true);
  assert.equal((await h.queue.command('status', { id: a.id })).jobs.filter(j => j.running).length, 2);
  await h.queue.command('stop', { id: c.id });
  h.gates.forEach(resolve => resolve());
  await h.queue.waitUntilIdle();
  assert.equal(h.entered.length, 2);
  assert.equal((await h.queue.command('status', { id: c.id })).job.phase, 'stopped');
});
test('queued album starts when a slot becomes free and duplicate active link is not added twice', async () => {
  const h = setup(2);
  const a = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/b' });
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/c' });
  assert.equal((await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' })).id, a.id);
  await until(() => h.gates.length === 2);
  h.gates[0]();
  await until(() => h.gates.length === 3);
  h.gates.forEach(resolve => resolve()); await h.queue.waitUntilIdle();
  assert.equal(h.files.length, 3);
});
test('overlapping folder trees in the same public album do not download simultaneously', async () => {
  const h = setup();
  await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  const sub = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a/sub' });
  await until(() => h.gates.length === 1);
  assert.equal(sub.queued, true);
  h.gates[0](); await until(() => h.gates.length === 2);
  h.gates[1](); await h.queue.waitUntilIdle();
});
test('browser restart preserves jobs but waits for explicit continue', async () => {
  const queue = createQueue({ loadEntries: async () => [{ id: 'saved', wanted: true, job: newJob('https://disk.yandex.ru/d/a') }],
    saveEntry: async () => {}, resource: async () => { throw new Error('Should not run'); }, downloads: {} });
  const state = await queue.command('status');
  assert.equal(state.jobs.length, 1); assert.equal(state.running, false); assert.equal(state.queued, false);
});

test('all-job issue details are requested on demand without truncation and preserve full breadcrumb paths', async () => {
  const a = newJob('https://disk.yandex.ru/d/a/2024/Trip');
  a.rootTitle = 'Family'; a.title = 'Trip'; a.directories = []; a.phase = 'done';
  a.files = Array.from({ length: 42 }, (_, n) => ({ name: `a${n}.JPG`, path: `/2024/Trip/a${n}.JPG`, state: 'failed', reason: 'Unavailable' }));
  const b = newJob('https://disk.yandex.ru/d/b');
  b.title = 'Another album'; b.phase = 'done'; b.directories = [{ path: '/Missing', state: 'failed', reason: 'HTTP 500' }];
  const queue = createQueue({ loadEntries: async () => [{ id: 'a', job: a }, { id: 'b', job: b }], saveEntry: async () => {}, downloads: {} });
  const compact = await queue.command('status', { id: 'a' });
  assert.equal(compact.job.issues.length, 30); assert.equal(compact.job.issuesTotal, 42);
  assert.equal(compact.jobs[0].issues, undefined);
  const full = await queue.command('status', { id: 'a', allIssues: true });
  assert.equal(full.jobs[0].issues.length, 42);
  assert.equal(full.jobs[0].issues[0].path, 'Family / 2024 / Trip / a0.JPG');
  assert.equal(full.jobs[1].issues[0].path, 'Another album / Missing');
  assert.equal(full.jobs[1].summary.directoriesFailed, 1);
});

test('seven independent albums share an explicitly raised file limit', async () => {
  const jobs = [];
  const unlimited = setup();
  for (let n = 0; n < 7; n++) jobs.push(await unlimited.queue.command('scan', { link: 'https://disk.yandex.ru/d/album-' + n }));
  await until(() => unlimited.entered.length === 7);
  assert.equal((await unlimited.queue.command('status')).jobs.filter(j => j.running).length, 7);
  unlimited.gates.forEach(resolve => resolve()); await unlimited.queue.waitUntilIdle();
  assert.equal(unlimited.files.length, 7);
});

test('restarting a stopped folder reuses its row instead of adding a duplicate', async () => {
  const h = setup();
  const first = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  await until(() => h.gates.length === 1);
  await h.queue.command('stop', { id: first.id }); await h.queue.waitUntilIdle();
  const next = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' });
  assert.equal(next.id, first.id); assert.equal(next.jobs.length, 1);
  await until(() => h.gates.length === 2);
  h.gates[1](); await h.queue.waitUntilIdle();
});

test('restart removes old stopped duplicates while preserving the latest job', async () => {
  const old = newJob('https://disk.yandex.ru/d/a'); old.phase = 'stopped'; old.created = '2026-01-01';
  const newer = newJob('https://disk.yandex.ru/d/a'); newer.created = '2026-01-02';
  const removed = [];
  const queue = createQueue({ loadEntries: async () => [{ id: 'old', job: old }, { id: 'new', job: newer }],
    saveEntry: async () => {}, deleteEntry: async id => { removed.push(id); }, downloads: {} });
  const result = await queue.command('status');
  assert.equal(result.jobs.length, 1); assert.equal(result.id, 'new'); assert.deepEqual(removed, ['old']);
});

test('stopping a checksum-lock waiter is immediate and does not release another job\'s lock', async () => {
  let finishPhoto, calls = 0, filename;
  const history = new Map();
  const queue = createQueue({ loadEntries: async () => [], saveEntry: async () => {},
    loadHistory: async key => structuredClone(history.get(key) || {}),
    saveHistory: async (key, value) => history.set(key, structuredClone(value)),
    resource: async () => ({ type: 'dir', name: 'Album', _embedded: { total: 1, offset: 0, items: [
      { type: 'file', name: 'a.JPG', path: '/a.JPG', size: 3, media_type: 'image', sha256: 'a'.repeat(64) }
    ] } }),
    getPhoto: async () => { calls++; await new Promise(resolve => { finishPhoto = resolve; }); return new Blob(['abc'], { type: 'image/jpeg' }); },
    downloads: { download: async args => { filename = args.filename; return 1; },
      search: async () => [{ id: 1, state: 'complete', exists: true, fileSize: 3, filename }], cancel: async () => {} },
    sleep: async () => {}
  });
  await queue.command('scan', { link: 'https://disk.yandex.ru/d/a', deduplicate: true });
  await until(() => calls === 1);
  const b = await queue.command('scan', { link: 'https://disk.yandex.ru/d/b', deduplicate: true });
  await tick();
  await queue.command('stop', { id: b.id });
  for (let n = 0; n < 10 && (await queue.command('status', { id: b.id })).running; n++) await tick();
  assert.equal((await queue.command('status', { id: b.id })).running, false);
  assert.equal((await queue.command('status', { id: b.id })).job.phase, 'stopped');
  await queue.command('scan', { link: 'https://disk.yandex.ru/d/c', deduplicate: true });
  await tick(); assert.equal(calls, 1);
  finishPhoto(); await queue.waitUntilIdle();
  assert.equal(calls, 1);
});
