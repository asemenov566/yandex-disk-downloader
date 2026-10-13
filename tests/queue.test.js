import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../extension/queue.js';
import { newJob } from '../extension/core.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await tick(); } throw new Error('Condition not reached'); }
function setup(concurrency) {
  const entered = [], gates = [], saved = new Map(), files = [];
  const queue = createQueue({
    concurrency, loadEntries: async () => [], saveEntry: async entry => { saved.set(entry.id, structuredClone(entry)); },
    resource: async job => ({ type: 'dir', name: job.publicUrl.split('/').pop(), _embedded: { total: 1, offset: 0,
      items: [{ type: 'file', name: 'a.JPG', path: job.path === '/' ? '/a.JPG' : job.path + '/a.JPG', size: 3, media_type: 'image' }] } }),
    getPhoto: async (job, _file, _kind, signal) => {
      entered.push(job.publicUrl + job.path);
      await new Promise((resolve, reject) => { gates.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      return new Blob(['abc'], { type: 'image/jpeg' });
    },
    downloads: {
      download: async args => { files.push(args); return files.length; },
      search: async ({ id }) => [{ id, state: 'complete', exists: true, fileSize: 3, filename: files[id - 1].filename }], cancel: async () => {}
    }, sleep: async () => {}
  });
  return { queue, entered, gates, saved, files };
}
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

test('production default has no album count limit: seven independent jobs start together', async () => {
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
