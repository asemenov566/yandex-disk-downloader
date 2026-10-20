import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../extension/queue.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let n = 0; n < 200; n++) { if (check()) return; await tick(); } throw new Error('Condition not reached'); }

test('timeout setting validates, persists, and does not reset the file limit', async () => {
  let settings = {};
  const options = { loadEntries: async () => [], saveEntry: async () => {}, loadSettings: async () => settings,
    saveSettings: async value => { settings = value; } };
  const queue = createQueue(options);
  assert.equal((await queue.command('status')).timeoutSeconds, 25);
  await queue.command('settings', { downloadLimit: 10 });
  for (const timeoutSeconds of [5, 15, 25, 40, 60, 120, 240]) {
    await queue.command('settings', { timeoutSeconds });
    assert.equal(settings.downloadLimit, 10);
    assert.equal((await createQueue(options).command('status')).timeoutSeconds, timeoutSeconds);
  }
  await queue.command('settings', { downloadLimit: 5 }); assert.equal(settings.timeoutSeconds, 240);
  await assert.rejects(queue.command('settings', { timeoutSeconds: 0 }));
  assert.equal(settings.timeoutSeconds, 240);
});

test('changed timeout reaches subsequent photos and streamed videos without changing an in-flight photo', async () => {
  const seen = [], writes = [];
  let release;
  const queue = createQueue({ loadEntries: async () => [], saveEntry: async () => {},
    resource: async () => ({ type: 'dir', name: 'Album', _embedded: { total: 3, offset: 0, items:
      ['a.jpg', 'b.jpg', 'c.mov'].map(name => ({ type: 'file', name, path: '/' + name, size: 3, media_type: name.endsWith('mov') ? 'video' : 'image' })) } }),
    getPhoto: async (_job, file, _kind, _signal, _progress, timeout) => {
      seen.push(timeout);
      if (file.name === 'a.jpg') await new Promise(resolve => { release = resolve; });
      return new Blob(['abc']);
    },
    getOriginalUrl: async () => 'https://downloader.disk.yandex.ru/test', downloads: {},
    saveLocal: async (path, _source, options) => { writes.push(options.timeout); return { savedPath: path, savedBytes: 3, localFile: true }; }
  });
  await queue.command('scan', { link: 'https://disk.yandex.ru/d/test' });
  await until(() => !!release);
  await queue.command('settings', { timeoutSeconds: 120 }); release(); await queue.waitUntilIdle();
  assert.deepEqual(seen, [25000, 120000]); assert.deepEqual(writes, [25000, 120000, 120000]);
});

test('HTTP 429 cancels concurrent files and leaves the album resumable', async () => {
  const attempts = [];
  let saved;
  const queue = createQueue({ loadEntries: async () => [], saveEntry: async entry => { saved = structuredClone(entry); },
    loadSettings: async () => ({ downloadLimit: 5 }),
    resource: async () => ({ type: 'dir', name: 'Album', _embedded: { total: 10, offset: 0, items:
      Array.from({ length: 10 }, (_, n) => ({ type: 'file', name: `${n}.jpg`, path: `/${n}.jpg`, size: 3, media_type: 'image' })) } }),
    getPhoto: async (_job, file, _kind, signal) => {
      attempts.push(file.name);
      if (file.name === '0.jpg') throw Object.assign(new Error('Rate limit'), { status: 429 });
      await new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }, downloads: {}
  });
  await queue.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await queue.waitUntilIdle();
  assert(attempts.length <= 5);
  assert.equal(saved.job.files.filter(f => f.state === 'pending').length, 10);
  assert.equal(saved.job.phase, 'downloading');
  assert.match((await queue.command('status')).notice, /Rate limit/);
});

test('saved limit restores independently of queue entries and defaults to one for old installations', async () => {
  const options = { loadEntries: async () => [], saveEntry: async () => {} };
  assert.equal((await createQueue(options).command('status')).downloadLimit, 1);
  assert.equal((await createQueue({ ...options, loadSettings: async () => ({ downloadLimit: 25 }) }).command('status')).downloadLimit, 25);
});

test('one album fills the file budget; pause waits for all cancellations and resume keeps completed files', async () => {
  const entered = [], gates = [], files = [], stored = new Map(), activity = [];
  let settings = {};
  const queue = createQueue({
    loadEntries: async () => [], saveEntry: async entry => stored.set(entry.id, structuredClone(entry)),
    loadSettings: async () => settings, saveSettings: async value => { settings = value; },
    onActivityChange: value => activity.push(value),
    resource: async () => ({ type: 'dir', name: 'Album', _embedded: { total: 8, offset: 0, items:
      Array.from({ length: 8 }, (_, n) => ({ type: 'file', name: `${n}.jpg`, path: `/${n}.jpg`, size: 3, media_type: 'image' })) } }),
    getPhoto: async (_job, file, _kind, signal) => {
      entered.push(file.path);
      await new Promise((resolve, reject) => { gates.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      return new Blob(['abc'], { type: 'image/jpeg' });
    },
    downloads: {
      download: async args => { files.push(args); return files.length; },
      search: async ({ id }) => [{ id, state: 'complete', exists: true, fileSize: 3, filename: files[id - 1].filename }], cancel: async () => {}
    }
  });
  const job = await queue.command('scan', { link: 'https://disk.yandex.ru/d/test' });
  await until(() => entered.length === 1);
  assert.equal((await queue.command('status')).downloadLimit, 1);
  await queue.command('settings', { downloadLimit: 5 });
  await until(() => entered.length === 5);
  assert.equal(settings.downloadLimit, 5);
  await queue.command('settings', { downloadLimit: 1 });
  gates[0](); await until(() => files.length === 1);
  await queue.command('pause', { id: job.id }); await queue.waitUntilIdle();
  assert.equal(activity.at(-1), false);
  assert.equal(stored.get(job.id).job.files.filter(f => f.state === 'done').length, 1);
  assert.equal(stored.get(job.id).job.files.filter(f => f.state === 'pending').length, 7);
  await queue.command('settings', { downloadLimit: 50 });
  await queue.command('start', { id: job.id });
  await until(() => gates.length === 12);
  gates.slice(5).forEach(resolve => resolve()); await queue.waitUntilIdle();
  assert.equal(files.length, 8);
  assert.equal(new Set(files.map(f => f.filename)).size, 8);
});
