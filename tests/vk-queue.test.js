import { createRunner } from '../extension/runner.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVkApiQueue } from '../extension/vk-api-queue.js';
import { createVkProvider } from '../extension/vk-provider.js';
import { createVkDownloadPool } from '../extension/pool.js';
import { retryNotFound, NOT_FOUND_DELAYS } from '../extension/retry.js';
import { photoResource } from '../extension/vk.js';
import { newJob } from '../extension/core.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await tick(); assert(check()); }
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const missing = () => Object.assign(new Error('missing'), { status: 404 });

test('pages pass a refresh backlog, dialogs rotate, and refreshes also receive service', async () => {
  const queue = createVkApiQueue({ refreshLimit: 3 }), block = gate(), order = [];
  const first = queue.run(() => block.promise, { key: 'A', refresh: true }); await tick();
  const jobs = Array.from({ length: 100 }, (_, n) => queue.run(async () => { order.push('R' + n % 3); }, { key: 'R' + n % 3, refresh: true }));
  assert.equal(queue.depth, 2); assert.equal(queue.waiting, 98);
  for (let n = 0; n < 12; n++) jobs.push(queue.run(async () => { order.push('P' + n % 3); }, { key: 'P' + n % 3 }));
  block.resolve(); await Promise.all([first, ...jobs]);
  assert.deepEqual(order.slice(0, 4), ['P0', 'P1', 'P2', 'R0']);
  assert.deepEqual(order.slice(4, 7), ['P0', 'P1', 'P2']);
  assert.equal(queue.depth, 0); assert.equal(queue.waiting, 0);
});

test('cancelled refresh admission and queued pages disappear without blocking other dialogs', async () => {
  const queue = createVkApiQueue({ refreshLimit: 1 }), block = gate(), controller = new AbortController();
  const first = queue.run(() => block.promise, { key: 'A', refresh: true }); await tick();
  let touched = false;
  const cancel = [queue.run(() => { touched = true; }, { key: 'B', refresh: true, signal: controller.signal }),
    queue.run(() => { touched = true; }, { key: 'B', signal: controller.signal })];
  const outcome = Promise.allSettled(cancel); controller.abort();
  assert((await outcome).every(r => r.status === 'rejected')); assert.equal(queue.waiting, 0);
  const next = queue.run(() => 'ok', { key: 'C' }); block.resolve();
  assert.equal(await next, 'ok'); await first; assert.equal(touched, false);
});

function photo(url) { return { cmid: 99, position: 1, attachment: { type: 'photo', photo: { id: 1, owner_id: 2,
  orig_photo: { url, width: 100, height: 100 }, sizes: [{ type: 'x', url, width: 100, height: 100 }] } } }; }
for (const changed of [false, true]) test('404 retries the cached URL before one final refresh, changed=' + changed, async () => {
  const oldUrl = 'https://sun9.vkuserphoto.ru/old.jpg', freshUrl = changed ? 'https://sun9.vkuserphoto.ru/new.jpg' : oldUrl;
  const file = photoResource(photo(oldUrl)), job = newJob('https://vk.ru/im/convo/1'); job.files = [file];
  const urls = []; let api = 0, elapsed = 0;
  const vk = createVkProvider({ sleep: async () => {}, send: async message => {
    assert.equal(urls.length, 7); assert.equal(elapsed, 94000); assert.equal(message.action, 'photo'); api++;
    return { ok: true, value: { ok: true, tabId: 1, value: { items: [photo(freshUrl)] } } };
  }, fetchImage: async url => { urls.push(url); if (url === oldUrl) throw missing(); return new Blob(['ok']); } });
  const work = () => retryNotFound((ms, attempt) => vk.getPhoto(job, file, 'original', new AbortController().signal, undefined, ms, () => {}, { refresh404: attempt === NOT_FOUND_DELAYS.length }),
    { timeout: 25000, sleep: async ms => { elapsed += ms; } });
  if (changed) assert.equal((await work()).size, 2); else await assert.rejects(work(), e => e.status === 404);
  assert.equal(api, 1); assert.deepEqual(urls.slice(0, 7), Array(7).fill(oldUrl)); assert.equal(urls.length, changed ? 8 : 7);
});

test('transient 404 succeeds on the same URL without any metadata request', async () => {
  let reads = 0;
  const vk = createVkProvider({ sleep: async () => {}, send: async () => { throw new Error('Unexpected refresh'); },
    fetchImage: async () => { if (++reads < 3) throw missing(); return new Blob(['ok']); } });
  const file = photoResource(photo('https://sun9.vkuserphoto.ru/old.jpg'));
  await retryNotFound((ms, attempt) => vk.getPhoto({ files: [file] }, file, 'original', new AbortController().signal, undefined, ms, () => {}, { refresh404: attempt === 6 }), { sleep: async () => {}, timeout: 25000 });
  assert.equal(reads, 3);
});

test('VK waiting cohort is bounded per media and cancellation releases every slot', async () => {
  const pool = createVkDownloadPool(5), controller = new AbortController(); let starts = 0;
  const blocked = () => new Promise((resolve, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const photos = pool.run(Array.from({ length: 100 }, () => ({ kind: 'photo' })), async (_file, lease) => { starts++; await lease.wait(blocked); }, controller.signal);
  const videos = pool.run(Array.from({ length: 100 }, () => ({ kind: 'video' })), async (_file, lease) => { starts++; await lease.wait(blocked); }, controller.signal);
  const settled = Promise.allSettled([photos, videos]);
  await until(() => starts === 10); await tick();
  assert.equal(pool.active, 0); assert.equal(pool.waiting, 10); assert.equal(starts, 10);
  controller.abort(); assert((await settled).every(r => r.status === 'rejected'));
  assert.equal(pool.active, 0); assert.equal(pool.waiting, 0);
});

test('a due retry reacquires the only slot before new files; limit never overshoots', async () => {
  const pool = createVkDownloadPool(1), retry = gate(), transfer = gate(), order = [];
  const work = pool.run([0,1,2].map(id => ({ id, kind: 'photo' })), async (file, lease) => {
    order.push('start' + file.id); assert(pool.active <= 1);
    if (file.id === 0) { await lease.wait(() => retry.promise); order.push('resume0'); assert.equal(pool.active, 1); }
    if (file.id === 1) await transfer.promise;
  });
  await until(() => order.includes('start1')); retry.resolve(); await tick();
  assert(!order.includes('resume0')); transfer.resolve(); await work;
  assert.deepEqual(order, ['start0', 'start1', 'resume0', 'start2']); assert.equal(pool.waiting, 0);
});


test('due retries respect a decreased limit and pause cancels reacquisition', async () => {
  const pool = createVkDownloadPool(5), controller = new AbortController(), ready = gate(), live = gate();
  let started = 0, resumed = 0;
  const work = pool.run(Array.from({ length: 40 }, (_, id) => ({ id, kind: 'photo' })), async (_file, lease) => {
    started++; await lease.wait(() => ready.promise); resumed++;
    await new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      live.promise.then(resolve);
    });
  }, controller.signal);
  const settled = Promise.allSettled([work]); await until(() => started === 8);
  pool.setLimit(1); ready.resolve(); await until(() => resumed === 1); await tick();
  assert.equal(pool.active, 1); assert.equal(started, 8); assert.equal(resumed, 1);
  controller.abort(); await settled; assert.equal(pool.active, 0); assert.equal(pool.waiting, 0);
});

test('refresh cooldown covers original and preview metadata of the same file', async () => {
  const url = 'https://sun9.vkuserphoto.ru/old.jpg', file = photoResource(photo(url)), job = newJob('https://vk.ru/im/convo/1'); job.files = [file];
  let calls = 0;
  const vk = createVkProvider({ sleep: async () => {}, fetchImage: async () => { throw missing(); }, send: async () => {
    calls++; return { ok: true, value: { ok: true, tabId: 1, value: { items: [photo(url)] } } };
  } });
  for (const kind of ['original', 'preview']) await assert.rejects(vk.getPhoto(job, file, kind, new AbortController().signal, undefined, 25000, () => {}, { refresh404: true }), e => e.status === 404);
  assert.equal(calls, 1);
});


test('runner completes a wave of transient 404s with bounded slot lending and no refresh calls', async () => {
  const job = newJob('https://vk.ru/im/convo/1', 'photos-original');
  job.title = 'Test'; job.folder = 'vk-messager/Test'; job.directories.forEach(dir => { dir.state = 'done'; });
  job.files = Array.from({ length: 20 }, (_, n) => {
    const item = photo('https://sun9.vkuserphoto.ru/' + n + '.jpg'); item.attachment.photo.id = n + 1; return photoResource(item);
  });
  const attempts = new Map(), pool = createVkDownloadPool(5), logs = []; let api = 0, receiving = 0, maxReceiving = 0;
  const vk = createVkProvider({ sleep: async () => {}, send: async message => {
    assert.equal(message.action, 'prepare'); api++;
    return { ok: true, value: { ok: true, tabId: 1, value: { title: 'Test' } } };
  }, fetchImage: async url => {
    receiving++; maxReceiving = Math.max(maxReceiving, receiving); await tick(); receiving--;
    const count = (attempts.get(url) || 0) + 1; attempts.set(url, count);
    if (count < 3) throw missing(); return new Blob(['ok']);
  } });
  const runner = createRunner({ loadJob: async () => job, saveJob: async () => {}, vk,
    runFiles: pool.run, getPhoto: (...args) => vk.getPhoto(...args), sleep: async () => tick(),
    trace: event => logs.push(event), saveLocal: async path => ({ savedPath: path, savedBytes: 2, localFile: true }) });
  await runner.command('start'); await runner.waitUntilIdle();
  assert.equal(job.files.filter(file => file.state === 'done').length, 20);
  assert.equal(api, 1); assert(maxReceiving <= 4); assert(logs.includes('file.slot.release'));
  assert.equal(pool.active, 0); assert.equal(pool.waiting, 0);
});


for (const changed of [false, true]) test('one refresh response serves queued neighboring files, changed=' + changed, async () => {
  const make = (id, fresh = false) => {
    const item = photo('https://sun9.vkuserphoto.ru/' + (fresh ? 'new' : 'old') + id + '.jpg');
    item.cmid = 1000 - id; item.attachment.photo.id = id; return item;
  };
  const job = newJob('https://vk.ru/im/convo/1'); job.files = Array.from({ length: 30 }, (_, i) => photoResource(make(i + 1)));
  const directories = structuredClone(job.directories), files = [...job.files]; let calls = 0;
  const vk = createVkProvider({ sleep: async () => {}, send: async message => {
    calls++; assert.equal(message.action, 'photo');
    return { ok: true, value: { ok: true, tabId: 1, value: { items: Array.from({ length: 30 }, (_, i) => make(i + 1, changed)) } } };
  }, fetchImage: async url => { if (url.includes('/old')) throw missing(); return new Blob(['ok']); } });
  const outcomes = await Promise.allSettled(files.map(file => vk.getPhoto(job, file, 'original', new AbortController().signal,
    undefined, 48000, () => {}, { refresh404: true })));
  assert.equal(calls, 1);
  assert(outcomes.every(result => changed ? result.status === 'fulfilled' : result.status === 'rejected' && result.reason.status === 404));
  assert.deepEqual(job.directories, directories); assert.equal(job.files.length, 30);
  assert(job.files.every((file, i) => file === files[i] && file.state === 'pending'));
});

test('batch refresh never adds files, changes pagination, or accepts another attachment as the requested one', async () => {
  const job = newJob('https://vk.ru/im/convo/1');
  const target = photoResource(photo('https://sun9.vkuserphoto.ru/old.jpg')); job.files = [target];
  const other = photo('https://sun9.vkuserphoto.ru/new.jpg'); other.attachment.photo.id = 88;
  const before = structuredClone(job);
  const vk = createVkProvider({ sleep: async () => {}, fetchImage: async () => { throw missing(); }, send: async () =>
    ({ ok: true, value: { ok: true, tabId: 1, value: { items: [other] } } }) });
  await assert.rejects(vk.getPhoto(job, target, 'original', new AbortController().signal, undefined, 48000, () => {}, { refresh404: true }), /больше не возвращает/);
  assert.deepEqual(job, before);
});

test('identical media identities in different dialogues do not share cached refresh results', async () => {
  const jobs = [1, 2].map(id => { const job = newJob('https://vk.ru/im/convo/' + id); job.files = [photoResource(photo('https://sun9.vkuserphoto.ru/old.jpg'))]; return job; });
  let calls = 0;
  const vk = createVkProvider({ sleep: async () => {}, fetchImage: async () => { throw missing(); }, send: async () => {
    calls++; return { ok: true, value: { ok: true, tabId: 1, value: { items: [photo('https://sun9.vkuserphoto.ru/old.jpg')] } } };
  } });
  await Promise.all(jobs.map(job => assert.rejects(vk.getPhoto(job, job.files[0], 'original', new AbortController().signal,
    undefined, 48000, () => {}, { refresh404: true }), error => error.status === 404)));
  assert.equal(calls, 2);
});
