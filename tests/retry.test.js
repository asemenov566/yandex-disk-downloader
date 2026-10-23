import { dataTimeoutError } from '../extension/wait.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { retryNotFound, NOT_FOUND_DELAYS } from '../extension/retry.js';
import { createRunner } from '../extension/runner.js';
import { newJob } from '../extension/core.js';
import { photoResource } from '../extension/vk.js';
const missing = () => Object.assign(new Error('missing'), { status: 404 });
test('404 retries wait 1,3,6,12,24,48 seconds and use each delay as its transfer timeout', async () => {
  const timeouts = [], starts = [], notices = []; let elapsed = 0;
  await assert.rejects(retryNotFound(async timeout => { timeouts.push(timeout); starts.push(elapsed); throw missing(); }, {
    timeout: 25000, signal: new AbortController().signal, sleep: async ms => { assert(ms <= 500); elapsed += ms; }, onStatus: text => notices.push(text)
  }), error => error.status === 404);
  assert.deepEqual(timeouts, [25000, ...NOT_FOUND_DELAYS]);
  assert.deepEqual(starts, [0,1000,4000,10000,22000,46000,94000]);
  assert(notices.at(-1).includes('48 с'));
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
    job.title = 'Test'; job.folder = (provider === 'vk' ? 'vk-messager/' : 'yandex-disk/') + 'Test';
    job.directories.forEach(dir => { dir.state = 'done'; });
    job.files = [provider === 'vk' ? photoResource({ cmid: 1, position: 1, attachment: { type: 'photo', photo: { id: 1, owner_id: 1, orig_photo: { url: 'https://sun9.vkuserphoto.ru/test', width: 100, height: 100 } } } }) : { path: '/1.jpg', local: '1.jpg', name: '1.jpg', size: 3, kind: 'photo', state: 'pending' }];
    const attempts = [], sleeps = []; let originals = 0;
    const runner = createRunner({ loadJob: async () => job, saveJob: async () => {},
      vk: { prepare: async () => ({ title: 'Test' }) }, sleep: async ms => sleeps.push(ms),
      getPhoto: async (_j,_f,kind,_signal,_progress,timeout) => { attempts.push([kind,timeout]); if (kind === 'original' && ++originals <= 2) throw missing(); return new Blob(['abc']); },
      saveLocal: async path => ({ savedPath: path, savedBytes: 3, localFile: true }) });
    await runner.command('start'); await runner.waitUntilIdle();
    assert.deepEqual(attempts, provider === 'vk' ? [['original',25000],['original',1000],['original',3000]] : [['original',25000],['preview',25000]]);
    assert.equal(sleeps.reduce((sum,ms)=>sum+ms,0), provider === 'vk' ? 4000 : 0);
  }
});


test('VK video keeps its MP4 URL through all 404 delays and refreshes once at exhaustion', async () => {
  const job = newJob('https://vk.ru/im/convo/1', 'videos'); job.title = 'Test'; job.folder = 'vk-messager/Test';
  job.directories.forEach(dir => { dir.state = 'done'; });
  job.files = [{ path: '/video1_1', local: 'video1_1.mp4', name: 'Видео от Test', title: 'Видео от Test', kind: 'video', state: 'pending',
    vk: { title: 'Видео от Test', cmid: 1, position: 1, video: { url: 'https://vkvd1.mycdn.me/test.mp4' } } }];
  let saves = 0, refreshes = 0;
  const url = 'https://vkvd1.mycdn.me/test.mp4';
  const runner = createRunner({ loadJob: async () => job, saveJob: async () => {}, sleep: async () => {},
    vk: { prepare: async () => ({ title: 'Test' }), getOriginalUrl: async (_j, _f, _s, refresh) => { assert(refresh); assert.equal(saves, 7); refreshes++; return url; } },
    getOriginalUrl: async () => url,
    saveLocal: async () => { saves++; throw missing(); } });
  await runner.command('start'); await runner.waitUntilIdle();
  assert.equal(saves, 7); assert.equal(refreshes, 1); assert.equal(job.files[0].state, 'failed');
});


test('short no-data timeouts after a 404 continue to later larger retry budgets', async () => {
  const budgets = [], notices = [];
  const result = await retryNotFound(async (ms, attempt) => {
    budgets.push(ms);
    if (attempt === 0) throw missing();
    if (attempt < 4) throw dataTimeoutError(ms);
    return 'original';
  }, { timeout: 240000, sleep: async () => {}, onStatus: text => notices.push(text) });
  assert.equal(result, 'original'); assert.deepEqual(budgets, [240000,1000,3000,6000,12000]);
  assert(notices.some(text => text.startsWith('Нет данных · повтор 2/6')));
});

test('continued timeouts stay bounded; initial timeout and unrelated errors do not start a 404 chain', async () => {
  let attempts = 0;
  await assert.rejects(retryNotFound(async (ms, attempt) => {
    attempts++; if (!attempt) throw missing(); throw dataTimeoutError(ms);
  }, { timeout: 25000, sleep: async () => {} }), error => error.dataTimeout === true);
  assert.equal(attempts, 7);
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
  const job = newJob('https://vk.ru/im/convo/1'); job.title = 'Test'; job.folder = 'vk-messager/Test';
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
