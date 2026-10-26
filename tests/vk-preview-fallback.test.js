import test from 'node:test';
import assert from 'node:assert/strict';
import { photoResource, stampVkLinks } from '../photo_downloader_smnv/vk.js';
import { newJob } from '../photo_downloader_smnv/core.js';
import { createVkProvider } from '../photo_downloader_smnv/vk-provider.js';
import { createRunner } from '../photo_downloader_smnv/runner.js';
import { issueLink } from '../photo_downloader_smnv/diagnostics-data.js';
const url = name => 'https://sun1.vkuserphoto.ru/' + name + '.jpg';
const missing = status => Object.assign(new Error('unavailable'), { status });
function item() { return { cmid: 10, position: 1, attachment: { type: 'photo', photo: { owner_id: 1, id: 2,
  orig_photo: { url: url('original'), width: 2000, height: 2000 }, sizes: [
    { type: 's', url: url('small'), width: 100, height: 100 },
    { type: 'w', url: url('large'), width: 1000, height: 1000 },
    { type: 'x', url: url('medium'), width: 500, height: 500 },
    { type: 'y', url: url('medium'), width: 500, height: 500 }
  ] } } }; }

test('all uncropped preview URLs are kept in descending size, deduplicated and retain their age', () => {
  const file = photoResource(item());
  assert.deepEqual(file.vk.previews.map(p => p.url), ['large','medium','small'].map(url));
  assert.equal(file.vk.preview.url, url('large'));
  stampVkLinks(file.vk, null, 100);
  const next = photoResource(item()); stampVkLinks(next.vk, file.vk, 200);
  assert(next.vk.previews.every(p => p.receivedAt === 100));
});

test('fallback visits other sizes once and selects only a successfully read image', async () => {
  const file = photoResource(item()), seen = [], job = { files: [file] }; let admissions = 0;
  const vk = createVkProvider({ send: async () => { throw new Error('No API refresh per alternate size'); }, fetchImage: async address => {
    seen.push(address); if (address !== url('small')) throw missing(404); return new Blob(['abc']);
  } });
  const result = await vk.getPreviewFallback(job, file, new AbortController().signal, undefined, 25000, undefined,
    { runRequest: work => { admissions++; return work(); } });
  assert.equal(result.size, 3); assert.deepEqual(seen, [url('medium'),url('small')]); assert.equal(admissions, 2);
  assert.equal(file.vk.preview.url, url('small')); assert.equal(file.vk.original.url, url('original'));
});

for (const status of [429,500,0]) test('fallback stops immediately on rate limit or transport failure ' + status, async () => {
  const file = photoResource(item()), seen = [];
  const vk = createVkProvider({ fetchImage: async address => { seen.push(address); throw missing(status); } });
  await assert.rejects(vk.getPreviewFallback({ files: [file] }, file, new AbortController().signal), e => e.status === status);
  assert.deepEqual(seen, [url('medium')]); assert.equal(file.vk.preview.url, url('large'));
});

for (const mode of ['auto', 'original', 'photos-original']) for (const originalWorks of [true, false]) {
  test('original and preview availability are independent: ' + mode + ', original=' + originalWorks, async () => {
    const job = newJob('https://vk.ru/im/convo/2000000001', mode); job.modeVersion = 1;
    job.title = 'Test'; job.folder = 'vk-messeger/Test'; job.files = [photoResource(item())];
    job.directories.forEach(d => { d.state = 'done'; });
    // A legacy global preview switch must never skip this file's VK original.
    job.usePreviews = true;
    const seen = [], saved = [];
    const vk = createVkProvider({ sleep: async () => {}, send: async message => ({ ok: true, value: { ok: true, tabId: 1,
      value: message.action === 'prepare' ? { title: 'Test' } : { items: [item()] } } }),
      fetchImage: async address => {
        seen.push(address);
        if (address === url(originalWorks ? 'original' : 'medium')) return new Blob(['abc'], {type:'image/jpeg'});
        throw missing(404);
      } });
    const runner = createRunner({ loadJob: async () => job, saveJob: async () => {}, vk, sleep: async () => {},
      getPhoto: (...args) => vk.getPhoto(...args), saveLocal: async path => { saved.push(path); return {savedPath:path,savedBytes:3,localFile:true}; } });
    await runner.command('start'); await runner.waitUntilIdle();
    if (originalWorks) {
      assert.deepEqual(seen, [url('original')]); assert.equal(job.files[0].savedKind, 'original'); assert.equal(saved.length, 1);
    } else if (mode === 'auto') {
      assert.equal(job.files[0].savedKind, 'preview'); assert.equal(saved.length, 1);
      assert.equal(seen.at(-1), url('medium')); assert(!seen.includes(url('small')));
      assert.equal(job.files[0].vk.preview.url, url('medium'));
    } else {
      assert.equal(job.files[0].state, 'failed'); assert.equal(saved.length, 0);
      assert(seen.every(address => address === url('original')));
    }
  });
}

test('active VK downloads and errors expose the same conversation viewer URL, never CDN data', async () => {
  const job = newJob('https://vk.ru/im/convo/2000000001'); job.modeVersion = 1;
  job.title = 'Test'; job.folder = 'vk-messeger/Test'; job.files = [photoResource(item())]; job.directories.forEach(d => { d.state = 'done'; });
  job.files[0].vk.accessKey = '0123456789abcdef01';
  const runner = createRunner({ loadJob: async () => job, saveJob: async () => {}, vk: { prepare: async () => ({title:'Test'}) },
    getPhoto: async (_job, _file, _kind, signal) => new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true})) });
  await runner.command('start');
  for(let n=0;n<20;n++) await new Promise(resolve => setImmediate(resolve));
  const state = await runner.command('status');
  const expected = 'https://vk.ru/im?z=photo1_2/0123456789abcdef01';
  assert.equal(state.job.activeFiles[0].url, expected); assert.equal(state.currentUrl, expected);
  await runner.command('pause'); await runner.waitUntilIdle();
  job.files[0].state = 'failed'; job.files[0].reason = 'test';
  assert.equal((await runner.command('status')).job.issues[0].url, expected);
  assert.equal(new URL(issueLink(job, {path:'/video1_2',kind:'video',vk:{cmid:10}})).searchParams.get('z'), 'video1_2');
});
