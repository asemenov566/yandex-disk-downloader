import { dataTimeoutError } from '../photo_downloader_smnv/wait.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { retryNotFound, NOT_FOUND_DELAYS, createNotFoundPolicy, NOT_FOUND_COOLDOWN } from '../photo_downloader_smnv/retry.js';
import { createRunner } from '../photo_downloader_smnv/runner.js';
import { newJob } from '../photo_downloader_smnv/core.js';
import { photoResource } from '../photo_downloader_smnv/vk.js';
const missing = () => Object.assign(new Error('missing'), { status: 404 });
test('404 retries wait 1,7,14 seconds and use each delay as its transfer timeout', async () => {
  const timeouts = [], starts = [], notices = []; let elapsed = 0;
  await assert.rejects(retryNotFound(async timeout => { timeouts.push(timeout); starts.push(elapsed); throw missing(); }, {
    timeout: 25000, signal: new AbortController().signal, sleep: async ms => { assert(ms <= 500); elapsed += ms; }, onStatus: text => notices.push(text)
  }), error => error.status === 404);
  assert.deepEqual(timeouts, [25000, ...NOT_FOUND_DELAYS]);
  assert.deepEqual(starts, [0,1000,8000,22000]);
  assert(notices.at(-1).includes('14 с'));
});
test('successful retry stops immediately; pause cancels waiting and non-404 is not retried', async () => {
  let attempts = 0;
  assert.equal(await retryNotFound(async () => { if (++attempts < 3) throw missing(); return 'ok'; }, { timeout: 25000, sleep: async () => {} }), 'ok');
  const controller = new AbortController();
  await assert.rejects(retryNotFound(async () => { throw missing(); }, { timeout: 25000, signal: controller.signal, sleep: async () => { controller.abort(); } }), { name: 'AbortError' });
  await assert.rejects(retryNotFound(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }, { timeout: 25000, sleep: () => { throw new Error('unexpected retry'); } }), /forbidden/);
});
test('runner retries VK originals before preview but never retries Yandex 404', async () => {
  for (const provider of ['vk', 'yandex']) {
    const job = newJob(provider === 'vk' ? 'https://vk.ru/im/convo/1' : 'https://disk.yandex.ru/d/test');
    job.title = 'Test'; job.folder = (provider === 'vk' ? 'vk-messeger/' : 'yandex-disk/') + 'Test';
    job.directories.forEach(dir => { dir.state = 'done'; });
    job.files = [provider === 'vk' ? photoResource({ cmid: 1, position: 1, attachment: { type: 'photo', photo: { id: 1, owner_id: 1, orig_photo: { url: 'https://sun9.vkuserphoto.ru/test', width: 100, height: 100 } } } }) : { path: '/1.jpg', local: '1.jpg', name: '1.jpg', size: 3, kind: 'photo', state: 'pending' }];
    const attempts = [], sleeps = []; let originals = 0;
    const runner = createRunner({ loadJob: async () => job, saveJob: async () => {},
      vk: { prepare: async () => ({ title: 'Test' }) }, sleep: async ms => sleeps.push(ms),
      getPhoto: async (_j,_f,kind,_signal,_progress,timeout) => { attempts.push([kind,timeout]); if (kind === 'original' && ++originals <= 2) throw missing(); return new Blob(['abc']); },
      saveLocal: async path => ({ savedPath: path, savedBytes: 3, localFile: true }) });
    await runner.command('start'); await runner.waitUntilIdle();
    assert.deepEqual(attempts, provider === 'vk' ? [['original',25000],['original',1000],['original',7000]] : [['original',25000],['preview',25000]]);
    assert.equal(sleeps.reduce((sum,ms)=>sum+ms,0), provider === 'vk' ? 8000 : 0);
  }
});


test('VK video keeps its MP4 URL through all 404 delays and refreshes once at exhaustion', async () => {
  const job = newJob('https://vk.ru/im/convo/1', 'videos'); job.title = 'Test'; job.folder = 'vk-messeger/Test';
  job.directories.forEach(dir => { dir.state = 'done'; });
  job.files = [{ path: '/video1_1', local: 'video1_1.mp4', name: 'Видео от Test', title: 'Видео от Test', kind: 'video', state: 'pending',
    vk: { title: 'Видео от Test', cmid: 1, position: 1, video: { url: 'https://vkvd1.mycdn.me/test.mp4' } } }];
  let saves = 0, refreshes = 0;
  const url = 'https://vkvd1.mycdn.me/test.mp4';
  const runner = createRunner({ loadJob: async () => job, saveJob: async () => {}, sleep: async () => {},
    vk: { prepare: async () => ({ title: 'Test' }), getOriginalUrl: async (_j, _f, _s, refresh) => { assert(refresh); assert.equal(saves, 4); refreshes++; return url; } },
    getOriginalUrl: async () => url,
    saveLocal: async () => { saves++; throw missing(); } });
  await runner.command('start'); await runner.waitUntilIdle();
  assert.equal(saves, 4); assert.equal(refreshes, 1); assert.equal(job.files[0].state, 'failed');
});


test('short no-data timeouts after a 404 continue to later larger retry budgets', async () => {
  const budgets = [], notices = [];
  const result = await retryNotFound(async (ms, attempt) => {
    budgets.push(ms);
    if (attempt === 0) throw missing();
    if (attempt < 3) throw dataTimeoutError(ms);
    return 'original';
  }, { timeout: 240000, sleep: async () => {}, onStatus: text => notices.push(text) });
  assert.equal(result, 'original'); assert.deepEqual(budgets, [240000,1000,7000,14000]);
  assert(notices.some(text => text.startsWith('Нет данных · повтор 2/3')));
});

test('continued timeouts stay bounded; initial timeout and unrelated errors do not start a 404 chain', async () => {
  let attempts = 0;
  await assert.rejects(retryNotFound(async (ms, attempt) => {
    attempts++; if (!attempt) throw missing(); throw dataTimeoutError(ms);
  }, { timeout: 25000, sleep: async () => {} }), error => error.dataTimeout === true);
  assert.equal(attempts, 4);
  for (const error of [dataTimeoutError(25000), new Error('Metadata timeout'), Object.assign(new Error('Denied'), { localAccess: true })]) {
    attempts = 0;
    await assert.rejects(retryNotFound(async () => { attempts++; throw error; }, { timeout: 25000, sleep: async () => {} }));
    assert.equal(attempts, 1);
  }
  attempts = 0;
  await assert.rejects(retryNotFound(async () => { if (++attempts === 1) throw missing(); throw new Error('Corrupt image'); }, { timeout: 25000, sleep: async () => {} }), /Corrupt/);
  assert.equal(attempts, 2);
});

test('runner keeps trying the original after a short retry timeout rather than falling back to preview', async () => {
  const job = newJob('https://vk.ru/im/convo/1'); job.title = 'Test'; job.folder = 'vk-messeger/Test';
  job.directories.forEach(dir => { dir.state = 'done'; });
  job.files = [photoResource({ cmid: 1, position: 1, attachment: { type: 'photo', photo: { id: 1, owner_id: 1,
    orig_photo: { url: 'https://sun9.vkuserphoto.ru/test', width: 100, height: 100 } } } })];
  const kinds = [];
  const runner = createRunner({ loadJob: async () => job, saveJob: async () => {}, sleep: async () => {},
    vk: { prepare: async () => ({ title: 'Test' }) },
    getPhoto: async (_j, _f, kind, _signal, _progress, ms) => {
      kinds.push(kind); if (kinds.length === 1) throw missing(); if (kinds.length === 2) throw dataTimeoutError(ms); return new Blob(['abc']);
    }, saveLocal: async path => ({ savedPath: path, savedBytes: 3, localFile: true }) });
  await runner.command('start'); await runner.waitUntilIdle();
  assert.deepEqual(kinds, ['original','original','original']); assert.equal(job.files[0].savedKind, 'original');
});

test('exhausted URLs receive one fresh probe; success, URL change, expiry and another file restore retries', async () => {
  let time = 0, url = 'https://sun9.vkuserphoto.ru/a.jpg', calls = 0, skipped = 0, good = false;
  const file = {}, policyFor = createNotFoundPolicy({ now: () => time });
  const run = async (target = file) => {
    const policy = policyFor(target, () => url, () => skipped++);
    return retryNotFound(async () => { calls++; if (good) return 'ok'; throw missing(); },
      { ...policy, timeout: 25000, sleep: async () => {}, onSuccess: policy.recovered });
  };
  await assert.rejects(run()); assert.equal(calls, 4);
  calls = 0; await assert.rejects(run()); assert.equal(calls, 1); assert.equal(skipped, 1);
  good = true; calls = 0; assert.equal(await run(), 'ok'); assert.equal(calls, 1);
  good = false; calls = 0; await assert.rejects(run()); assert.equal(calls, 4);
  url = 'https://sun9.vkuserphoto.ru/b.jpg';
  calls = 0; await assert.rejects(run()); assert.equal(calls, 4);
  calls = 0; await assert.rejects(run({})); assert.equal(calls, 4);
  time += NOT_FOUND_COOLDOWN;
  calls = 0; await assert.rejects(run()); assert.equal(calls, 4);
});

test('original and preview failures retain independent cooldowns; timeouts and changed URLs are not marked exhausted', async () => {
  const policyFor = createNotFoundPolicy(), file = {};
  let url = 'original', calls = 0;
  async function run(work = async () => { throw missing(); }) {
    const policy = policyFor(file, () => url);
    return retryNotFound(async (...args) => { calls++; return work(...args); },
      { ...policy, timeout: 25000, sleep: async () => {}, onSuccess: policy.recovered });
  }
  for (const value of ['original', 'preview']) { url = value; calls = 0; await assert.rejects(run()); assert.equal(calls, 4); }
  for (const value of ['original', 'preview']) { url = value; calls = 0; await assert.rejects(run()); assert.equal(calls, 1); }
  url = 'timeout';
  await assert.rejects(run(async (ms, attempt) => { if (!attempt) throw missing(); throw dataTimeoutError(ms); }));
  calls = 0; await assert.rejects(run()); assert.equal(calls, 4);
  url = 'old';
  await assert.rejects(run(async (_ms, attempt) => { if (attempt === 3) url = 'new'; throw missing(); }));
  calls = 0; await assert.rejects(run()); assert.equal(calls, 4);
});

for (const kind of ['photo', 'video']) test('runner avoids repeating the long 404 chain for the same VK ' + kind, async () => {
  const job = newJob('https://vk.ru/im/convo/101', kind === 'video' ? 'videos' : 'photos-original');
  job.title = 'Test'; job.folder = 'vk-messeger/Test'; job.directories.forEach(dir => { dir.state = 'done'; });
  const url = kind === 'video' ? 'https://vkvd1.okcdn.ru/test.mp4' : 'https://sun9.vkuserphoto.ru/test.jpg';
  job.files = [kind === 'photo' ? photoResource({ cmid: 1, position: 1, attachment: { type: 'photo',
    photo: { id: 1, owner_id: 1, orig_photo: { url, width: 100, height: 100 } } } }) :
    { path: '/video1_1', local: 'video1_1.mp4', name: 'Видео от Test', title: 'Видео от Test', kind: 'video', state: 'pending',
      vk: { title: 'Видео от Test', cmid: 1, position: 1, video: { url } } }];
  let reads = 0, refreshes = 0, elapsed = 0; const events = [];
  const runner = createRunner({ loadJob: async () => job, saveJob: async () => {}, sleep: async ms => { elapsed += ms; },
    trace: event => events.push(event),
    vk: { prepare: async () => ({ title: 'Test' }), getOriginalUrl: async () => { refreshes++; return url; } },
    getOriginalUrl: async () => url,
    getPhoto: async () => { reads++; throw missing(); },
    saveLocal: async () => { reads++; throw missing(); } });
  await runner.command('start'); await runner.waitUntilIdle();
  assert.equal(reads, 4); assert.equal(elapsed, 22000);
  reads = 0; elapsed = 0;
  await runner.command('retry', { preserveNewFiles: true }); await runner.waitUntilIdle();
  assert.equal(reads, 1); assert.equal(elapsed, 0);
  assert(events.includes('file.retry.skip'));
  assert.equal(refreshes, kind === 'video' ? 1 : 0);
});
