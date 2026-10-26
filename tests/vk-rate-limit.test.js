import test from 'node:test';
import assert from 'node:assert/strict';
import { createVkRateLimit } from '../photo_downloader_smnv/vk-rate-limit.js';
import { fileHttpError, retryAfterMs } from '../photo_downloader_smnv/http-errors.js';
import { fetchPhoto } from '../photo_downloader_smnv/network.js';
import { saveLocalFile } from '../photo_downloader_smnv/local-files.js';
import { createQueue } from '../photo_downloader_smnv/queue.js';
import { newJob } from '../photo_downloader_smnv/core.js';
import { photoResource } from '../photo_downloader_smnv/vk.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let n = 0; n < 12; n++) await tick(); }
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const http = (status, retryAfter) => fileHttpError(new Response('', { status, headers: retryAfter ? { 'Retry-After': retryAfter } : {} }));
function clock() {
  let at = 0, sleepers = [];
  return { now: () => at, sleep: ms => new Promise(resolve => sleepers.push({ end: at + ms, resolve })),
    async advance(ms) { at += ms; const due = sleepers.filter(s => s.end <= at); sleepers = sleepers.filter(s => s.end > at); due.forEach(s => s.resolve()); await settle(); } };
}

test('Retry-After accepts seconds and HTTP dates without allowing invalid values', () => {
  assert.equal(retryAfterMs('120'), 120000);
  assert.equal(retryAfterMs('0'), 0);
  const at = Date.parse('Fri, 23 Oct 2026 17:00:00 GMT');
  assert.equal(retryAfterMs('Fri, 23 Oct 2026 17:02:00 GMT', at), 120000);
  assert.equal(retryAfterMs('Fri, 23 Oct 2026 16:00:00 GMT', at), 0);
  for (const value of [null, '', ' ', '-1', '1.5', 'Infinity', '9999999999999999999999', '2026', 'invalid']) {
    if (value === '2026') assert.equal(retryAfterMs(value), 2026000);
    else assert.equal(retryAfterMs(value), undefined);
  }
});

test('photo and direct video errors keep Retry-After; failed video creates no file', async () => {
  const previous = globalThis.fetch; let created = false;
  const root = { queryPermission: async () => 'granted', getDirectoryHandle: async () => root,
    getFileHandle: async (_name, options) => { if (options?.create) created = true; throw new DOMException('Missing', 'NotFoundError'); } };
  const fetcher = async () => new Response('', { status: 429, headers: { 'Retry-After': '180' } });
  try {
    globalThis.fetch = fetcher;
    const check = error => error.fileServer && error.status === 429 && error.retryAfterMs === 180000;
    await assert.rejects(fetchPhoto('https://sun9.vkuserphoto.ru/test.jpg', {}, 'original'), check);
    await assert.rejects(saveLocalFile(root, 'vk-messeger/Test/video.mp4', 'https://vkvd1.okcdn.ru/test.mp4', { direct: true, fetcher }), check);
    assert.equal(created, false);
  } finally { globalThis.fetch = previous; }
});

test('in-flight 429s coalesce; every session waits and only one recovery probe starts', async () => {
  const time = clock(), events = [], gate = createVkRateLimit({ ...time, trace: (event, data) => events.push({event, ...data}) });
  const controller = new AbortController(), first = deferred(), second = deferred(), probe = deferred(); let starts = 0, releases = 0;
  const options = { signal: controller.signal, wait: async work => { releases++; return work(); } };
  const a = gate.run(async () => { starts++; if (starts === 1) return first.promise; return probe.promise; }, options);
  const b = gate.run(async () => { starts++; return second.promise; }, options);
  const all = Promise.allSettled([a,b]);
  first.reject(http(429)); second.reject(http(429)); await settle();
  assert.equal(events.filter(e => e.event === 'vk.rate.limit').length, 1);
  assert.equal(events[0].ms, 60000); assert(releases >= 2); assert.match(gate.status(), /429/);
  await time.advance(59000); assert.equal(starts, 2);
  await time.advance(1000); assert.equal(starts, 3); assert.match(gate.status(), /проверяем/);
  await time.advance(10000); assert.equal(starts, 3);
  controller.abort(); probe.reject(controller.signal.reason); await all;
});

test('server wait overrides fallback; failed probe increases pause; recovery is paced', async () => {
  const time = clock(), events = [], gate = createVkRateLimit({ ...time, trace: (event, data) => events.push({event, ...data}) });
  let calls = 0;
  const task = gate.run(async () => { calls++; if (calls <= 2) throw http(429, calls === 1 ? '180' : undefined); return 'ok'; });
  await settle(); await time.advance(179000); assert.equal(calls, 1);
  await time.advance(1000); assert.equal(calls, 2);
  assert.equal(events.filter(e => e.event === 'vk.rate.limit')[1].ms, 120000);
  await time.advance(119000); assert.equal(calls, 2);
  await time.advance(1000); assert.equal(await task, 'ok'); assert.equal(gate.status(), '');
  const starts = [];
  const next = [1,2,3].map(id => gate.run(async () => { starts.push(id); return id; }));
  await settle(); assert.equal(starts.length, 0);
  for (let n = 1; n <= 3; n++) { await time.advance(1000); assert.equal(starts.length, n); }
  assert.deepEqual(await Promise.all(next), [1,2,3]);
});

test('stale successful transfers cannot clear a newer cooldown; 404 probe releases it', async () => {
  const time = clock(), gate = createVkRateLimit(time), old = deferred(); let calls = 0;
  const stale = gate.run(() => old.promise);
  const task = gate.run(async () => { if (++calls === 1) throw http(429); throw http(404); });
  const outcome = assert.rejects(task, error => error.status === 404);
  await settle(); old.resolve('ok'); await stale; assert.match(gate.status(), /429/);
  await time.advance(60000); await outcome; assert.equal(gate.status(), '');
});

test('API 429 does not enter the file gate; cancellation releases the probe for another session', async () => {
  const time = clock(), gate = createVkRateLimit(time), controller = new AbortController(); let calls = 0;
  await assert.rejects(gate.run(async () => { throw Object.assign(new Error('API'), { status: 429 }); }), /API/);
  assert.equal(gate.status(), '');
  const task = gate.run(async () => { if (++calls === 1) throw http(429);
    return new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  }, { signal: controller.signal });
  const outcome = assert.rejects(task, error => error.name === 'AbortError');
  await settle(); await time.advance(60000); assert.equal(calls, 2);
  controller.abort(); await outcome;
  let recovered = false; const next = gate.run(async () => { recovered = true; return 'ok'; });
  await time.advance(1000); assert.equal(await next, 'ok'); assert(recovered);
});

test('queue shares cooldown across VK sessions, exposes reason, keeps Yandex running and preserves pending files on pause', async () => {
  const time = clock();
  const jobs = [1,2].map(id => {
    const job = newJob('https://vk.ru/im/convo/' + id, 'original');
    job.title = 'Test ' + id; job.folder = 'vk-messeger/Test ' + id;
    job.files = [photoResource({ cmid: 1, position: 1, attachment: { type: 'photo', photo: { id: id, owner_id: 1,
      orig_photo: { url: 'https://sun9.vkuserphoto.ru/test.jpg', width: 100, height: 100 } } } })];
    job.directories.forEach(d => { d.state = 'done'; }); return job;
  });
  const yd = newJob('https://disk.yandex.ru/d/test', 'original'); yd.title = 'Yandex'; yd.folder = 'yandex-disk/Test'; yd.directories = [];
  yd.files = [{ name: 'test.jpg', path: '/test.jpg', local: 'test.jpg', kind: 'photo', size: 3, state: 'pending' }];
  jobs.push(yd); let vkCalls = 0, ydCalls = 0, available = false;
  const queue = createQueue({ ...time, loadEntries: async () => jobs.map((job, i) => ({ id: String(i), job })), saveEntry: async () => {},
    vk: { prepare: async () => ({ title: 'Test' }) },
    getPhoto: async job => { if (job.provider === 'vk') { vkCalls++; if (!available) throw http(429); } else ydCalls++; return new Blob(['abc']); },
    saveLocal: async path => ({ savedPath: path, savedBytes: 3, localFile: true }) });
  await queue.command('start', { id: '0' }); await settle(); assert.equal(vkCalls, 1);
  await queue.command('start', { id: '1' }); await queue.command('start', { id: '2' }); await settle();
  assert.equal(vkCalls, 1); assert.equal(ydCalls, 1);
  const state = await queue.command('status', { id: '1' });
  assert.match(state.current, /общая пауза/); assert(state.jobs.filter(j => j.running).every(j => /429/.test(j.current)));
  assert.equal(state.jobs.find(j => j.id === '2').summary.done, 1);
  await queue.command('pauseAll'); await queue.waitUntilIdle();
  assert(jobs.slice(0,2).every(job => job.files[0].state === 'pending'));
  await queue.command('start', { id: '0' }); await settle(); assert.equal(vkCalls, 1);
  available = true;
  await time.advance(60000); await queue.waitUntilIdle();
  assert.equal(jobs[0].files[0].state, 'done'); assert.equal(jobs[0].runNewFiles, 1);
  await queue.command('start', { id: '1' }); await settle(); assert.equal(vkCalls, 2);
  await time.advance(1000); await queue.waitUntilIdle();
  assert.equal(jobs[1].files[0].state, 'done'); assert.equal(jobs[1].runNewFiles, 1);
});

test('a slot delayed during reacquisition rechecks a newer cooldown before sending', async () => {
  const time = clock(), gate = createVkRateLimit(time), controller = new AbortController();
  let calls = 0, delayed = false; const slot = deferred();
  const waitingTask = gate.run(async () => { calls++; throw http(429); }, {
    signal: controller.signal,
    wait: async work => { await work(); delayed = true; await slot.promise; }
  });
  const outcome = assert.rejects(waitingTask, error => error.name === 'AbortError');
  await settle(); await time.advance(60000); assert(delayed);
  let otherCalls = 0;
  const other = gate.run(async () => { otherCalls++; throw http(429); }, { signal: controller.signal });
  const otherOutcome = assert.rejects(other, error => error.name === 'AbortError');
  await settle(); assert.equal(otherCalls, 1);
  slot.resolve(); await settle(); assert.equal(calls, 1);
  controller.abort(); await Promise.all([outcome, otherOutcome]);
});
