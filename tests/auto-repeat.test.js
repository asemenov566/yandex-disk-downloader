import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../extension/queue.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 1));
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await tick(); } throw Error('Timeout'); }
function setup(repeats = 0, getPhoto = async () => { throw Error('Unavailable'); }) {
  const saved = new Map(), calls = [], scans = []; let settings;
  const queue = createQueue({ loadEntries: async () => [], loadSettings: async () => ({ completionRepeats: repeats }),
    saveEntry: async entry => saved.set(entry.id, structuredClone(entry)), saveSettings: async value => { settings = value; },
    resource: async job => { scans.push(job.publicUrl); return { type: 'dir', name: 'Album', _embedded: { total: 1, offset: 0,
      items: [{ type: 'file', name: 'a.jpg', path: '/a.jpg', media_type: 'image', size: 3 }] } }; },
    getPhoto: async (...args) => { calls.push({ url: args[0].publicUrl, kind: args[2] }); return getPhoto(...args); },
    saveLocal: async (savedPath, _source, options) => ({ savedPath, savedBytes: options.expectedSize, localFile: true }) });
  return { queue, saved, calls, scans, settings: () => settings };
}

test('auto retry budget is per session, retries only failures and preserves the scanned list', async () => {
  const h = setup(3);
  for (const name of ['a', 'b']) await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/' + name, mode: 'original' });
  await h.queue.waitUntilIdle();
  const state = await h.queue.command('status');
  assert.equal(state.completionRepeats, 3); assert(state.jobs.every(j => j.completed && j.autoRepeats === 3));
  for (const name of ['a', 'b']) assert.equal(h.calls.filter(x => x.url.endsWith('/' + name)).length, 4);
  assert.equal(h.scans.length, 2);
  await h.queue.command('retry', { id: state.jobs[0].id, includePreviews: true }); await h.queue.waitUntilIdle();
  assert.equal(h.calls.filter(x => x.url.endsWith('/a')).length, 8);
  assert.equal(h.calls.filter(x => x.url.endsWith('/b')).length, 4);
});

test('zero disables auto retries, changing settings persists and success ends retries early', async () => {
  let good = false; const h = setup(0, async () => { if (!good) throw Error('Unavailable'); return new Blob(['abc']); });
  const state = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a', mode: 'original' }); await h.queue.waitUntilIdle();
  assert.equal(h.calls.length, 1);
  await h.queue.command('settings', { completionRepeats: 2 }); assert.equal(h.settings().completionRepeats, 2);
  await assert.rejects(h.queue.command('settings', { completionRepeats: 4 }), /0 до 3/);
  good = true; await h.queue.command('retry', { id: state.id, includePreviews: true }); await h.queue.waitUntilIdle();
  assert.equal(h.calls.length, 2); assert.equal((await h.queue.command('status')).jobs[0].autoRepeats, 0);
});

test('preview originals are retried automatically but an explicit unchecked preview option is respected', async () => {
  const h = setup(2, async (_job, _file, kind) => { if (kind === 'original') throw Error('No original'); return new Blob(['abc']); });
  const first = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a' }); await h.queue.waitUntilIdle();
  assert.equal(h.calls.filter(x => x.kind === 'original').length, 3);
  assert.equal((await h.queue.command('status')).job.summary.previews, 1);
  await h.queue.command('retry', { id: first.id, includePreviews: false }); await h.queue.waitUntilIdle();
  assert.equal(h.calls.filter(x => x.kind === 'original').length, 3);
  assert.equal((await h.queue.command('status')).jobs[0].autoRepeats, 0);
});

test('manual pause during auto retry cancels further retries and resets the budget for a manual resume', async () => {
  let count = 0, block = true;
  const h = setup(2, async (_job, _file, _kind, signal) => {
    count++;
    if (count === 2 && block) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    throw Error('Unavailable');
  });
  const first = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a', mode: 'original' });
  await until(() => count === 2);
  assert.equal((await h.queue.command('status')).jobs[0].autoRepeats, 1);
  await h.queue.command('pause', { id: first.id }); await h.queue.waitUntilIdle();
  assert.equal(count, 2); assert.equal((await h.queue.command('status')).jobs[0].autoRepeats, 0);
  block = false; await h.queue.command('start', { id: first.id }); await h.queue.waitUntilIdle();
  assert.equal(count, 5); assert.equal((await h.queue.command('status')).jobs[0].autoRepeats, 2);
});

test('manual pause remains a pause even when the stored phase was done; resume clears it', async () => {
  const h = setup(0);
  const initial = await h.queue.command('scan', { link: 'https://disk.yandex.ru/d/a', mode: 'original' });
  await h.queue.waitUntilIdle();
  await h.queue.command('pause', { id: initial.id });
  const paused = await h.queue.command('status', { id: initial.id });
  assert.equal(paused.paused, true); assert.equal(paused.jobs[0].paused, true);
  assert.equal(paused.jobs[0].completed, false); assert.equal(paused.jobs[0].resumable, true);
  await h.queue.command('start', { id: initial.id }); await h.queue.waitUntilIdle();
  assert.equal((await h.queue.command('status')).jobs[0].completed, true);
});
