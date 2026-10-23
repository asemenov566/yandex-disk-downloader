import test from 'node:test';
import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { createQueue } from '../extension/queue.js';
import { newJob } from '../extension/core.js';
import { photoResource, videoResource } from '../extension/vk.js';
import { decodeState, encodeState } from '../extension/portable-state.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 500; i++) { if (check()) return; await tick(); } throw new Error('Condition not reached'); }
function entry(provider, id, mode = 'auto', count = 1) {
  const job = newJob(provider === 'vk' ? `https://vk.ru/im/convo/${id}` : `https://disk.yandex.ru/d/${id}`, mode);
  job.title = String(id); job.folder = (provider === 'vk' ? 'vk-messager/' : 'yandex-disk/') + id; job.phase = 'ready';
  job.directories.forEach(dir => { dir.state = 'done'; dir.cursor = { cmid: 100, position: 1 }; });
  const media = `https://sun9.vkuserphoto.ru/${id}.jpg`;
  for (let n = 0; n < count; n++) {
    job.files.push(provider === 'vk' ? photoResource({ cmid: 100 + n, position: 1,
      attachment: { type: 'photo', photo: { id: n + 1, owner_id: id,
        orig_photo: { url: media, width: 100, height: 100 }, sizes: [{ type: 'm', url: media, width: 10, height: 10 }] } } }) :
      { path: `/${n}.jpg`, name: `${n}.jpg`, local: `${n}.jpg`, kind: 'photo', size: 3, state: 'pending' });
    job.files.push(provider === 'vk' ? videoResource({ cmid: 100 + n, position: 1,
      attachment: { type: 'video', video: { id: n + 1, owner_id: id, title: 'Видео от любого участника', files: { mp4_720: 'https://vkvd.okcdn.ru/movie.mp4' } } } }) :
      { path: `/${n}.mp4`, name: `${n}.mp4`, local: `${n}.mp4`, kind: 'video', size: 3, mime: 'video/mp4', state: 'pending' });
  }
  return { id: String(id), job };
}
function setup(entries, settings = {}, options = {}) {
  const gates = [], written = [], reads = [], saved = new Map(entries.map(e => [e.id, e]));
  let block = !!options.block, storedSettings = settings;
  async function gate(id, kind, signal) {
    signal.throwIfAborted(); setMaxListeners(0, signal);
    if (!block) return;
    await new Promise((resolve, reject) => {
      const row = { id: String(id), kind, active: true, cancelled: false };
      const finish = () => { row.active = false; signal.removeEventListener('abort', abort); };
      const abort = () => { finish(); row.cancelled = true; reject(signal.reason); };
      row.release = () => { finish(); resolve(); };
      gates.push(row); signal.addEventListener('abort', abort, { once: true });
    });
  }
  const deps = { loadEntries: async () => [...saved.values()], saveEntry: async e => { saved.set(e.id, e); },
    loadSettings: async () => storedSettings, saveSettings: async next => { storedSettings = next; },
    vk: { prepare: async job => ({ title: job.title }), nextPage: async () => { throw new Error('Unexpected pagination'); } },
    getPhoto: async (job, file, kind, signal) => {
      reads.push({ id: job.title, kind, file: file.path });
      await gate(job.title, 'photo', signal);
      if (options.failOriginal && kind === 'original') throw new Error('No original');
      return new Blob(['abc'], { type: 'image/jpeg' });
    }, getOriginalUrl: async (_job, file) => file.vk?.video?.url || 'https://downloader.disk.yandex.ru/video',
    saveLocal: async (path, _source, args) => {
      if (args.direct) await gate(path.split('/')[1], 'video', args.signal);
      written.push(path); return { savedPath: path, savedBytes: 3, localFile: true };
    }, sleep: async () => {} };
  return { queue: createQueue(deps), deps, gates, written, reads, saved,
    settings: () => storedSettings,
    active: (id, kind) => gates.filter(row => row.active && (id == null || row.id === String(id)) && (!kind || row.kind === kind)).length,
    release: () => { block = false; gates.filter(row => row.active).forEach(row => row.release()); } };
}

test('five modes select media and photo fallback for both Yandex and VK', async () => {
  for (const provider of ['yd', 'vk']) for (const mode of ['auto', 'original', 'photos-auto', 'photos-original', 'videos']) {
    const h = setup([entry(provider, 101, mode)], {}, { failOriginal: true });
    await h.queue.command('resumeAll'); await h.queue.waitUntilIdle();
    const files = h.saved.get('101').job.files;
    const photo = files.find(f => f.kind === 'photo'), video = files.find(f => f.kind === 'video');
    assert.equal(photo.state, mode === 'videos' ? 'skipped' : mode.endsWith('original') ? 'failed' : 'done', `${provider}:${mode}`);
    assert.equal(video.state, mode.startsWith('photos-') ? 'skipped' : 'done');
    assert.equal(h.reads.filter(r => r.kind === 'preview').length, ['auto', 'photos-auto'].includes(mode) ? 1 : 0);
    assert.equal(h.written.filter(path => path.endsWith('.mp4')).length, mode.startsWith('photos-') ? 0 : 1);
  }
});

test('twenty VK jobs each get 20 photo and 10 video slots, independently of Yandex limits', async () => {
  const entries = [...Array.from({ length: 20 }, (_, i) => entry('vk', 100 + i, 'auto', 30)),
    entry('yd', 201, 'auto', 50), entry('yd', 202, 'auto', 50)];
  const h = setup(entries, { downloadLimit: 1, vkDownloadLimit: 1 }, { block: true });
  await h.queue.command('resumeAll'); await until(() => h.active() === 22);
  await h.queue.command('settings', { vkDownloadLimit: 30 }); await until(() => h.active() === 602);
  for (let id = 100; id < 120; id++) {
    assert.equal(h.active(id, 'photo'), 20); assert.equal(h.active(id, 'video'), 10);
  }
  assert.equal(h.active(201), 1); assert.equal(h.active(202), 1);
  await h.queue.command('settings', { downloadLimit: 50 }); await until(() => h.active() === 700);
  assert.equal(h.active(201), 50); assert.equal(h.active(202), 50);
  assert.equal((await h.queue.command('status')).activeDownloads, 700);
  await h.queue.command('pauseAll'); await h.queue.waitUntilIdle();
  assert.equal(h.active(), 0); assert.equal((await h.queue.command('status')).activeDownloads, 0);
  const restored = createQueue(h.deps);
  assert.equal((await restored.command('status')).vkDownloadLimit, 30);
  assert.equal((await restored.command('status')).downloadLimit, 50);
  await assert.rejects(restored.command('settings', { vkDownloadLimit: 20 }));
  assert.equal(h.settings().vkDownloadLimit, 30);
});

test('VK photo-only and video-only jobs use only their reserved slots', async () => {
  for (const [mode, kind, count] of [['photos-auto', 'photo', 20], ['videos', 'video', 10]]) {
    const h = setup([entry('vk', 101, mode, 30)], { vkDownloadLimit: 30 }, { block: true });
    await h.queue.command('resumeAll'); await until(() => h.active() === count);
    assert.equal(h.active(101, kind), count);
    await h.queue.command('pauseAll'); await h.queue.waitUntilIdle();
  }
});

test('changing mode while VK files stream cancels excluded video and can enable it again without losing cursors', async () => {
  const h = setup([entry('vk', 101)], { vkDownloadLimit: 5 }, { block: true });
  await h.queue.command('resumeAll'); await until(() => h.active() === 2);
  const before = structuredClone(h.saved.get('101').job.directories);
  await h.queue.command('mode', { id: '101', mode: 'photos-auto' });
  await until(() => h.active() === 1);
  assert.equal(h.active(101, 'video'), 0);
  assert(h.gates.some(g => g.kind === 'video' && g.cancelled));
  assert.equal(h.saved.get('101').job.files.find(f => f.kind === 'video').disabledBySetting, true);
  await h.queue.command('mode', { id: '101', mode: 'original' }); await until(() => h.active() === 2);
  h.release(); await h.queue.waitUntilIdle();
  assert.equal(h.written.length, 2); assert.equal(new Set(h.written).size, 2);
  assert.deepEqual(h.saved.get('101').job.directories, before);
});

test('Yandex can stop streaming video then resume it later, without downloading completed photos again', async () => {
  const e = entry('yd', 101, 'videos');
  const h = setup([e], {}, { block: true });
  await h.queue.command('resumeAll'); await until(() => h.active(101, 'video') === 1);
  await h.queue.command('mode', { id: '101', mode: 'photos-original' }); await until(() => h.active(101, 'photo') === 1);
  assert.equal(h.active(101, 'video'), 0); assert(h.gates[0].cancelled);
  h.release(); await h.queue.waitUntilIdle();
  assert.equal(h.written.length, 1);
  await h.queue.command('mode', { id: '101', mode: 'auto' });
  assert((await h.queue.command('status')).jobs[0].resumable);
  await h.queue.command('resumeAll'); await h.queue.waitUntilIdle();
  assert.equal(h.written.length, 2); assert.equal(h.reads.length, 1);
});

test('legacy database always migrates to the new default; new mode survives JSON restore', async () => {
  for (const provider of ['yd', 'vk']) {
    const e = entry(provider, 101, 'original');
    delete e.job.modeVersion; e.job.usePreviews = true; e.job.originalFailures = 9;
    e.job.files[0].state = 'done';
    const positions = structuredClone(e.job.directories);
    const encoded = encodeState({ entries: [e], history: [], settings: {} }, '1.4.1');
    const decoded = decodeState(encoded).data;
    const h = setup(decoded.entries);
    await h.queue.ready;
    const job = h.saved.get('101').job;
    assert.equal(job.mode, 'auto'); assert.equal(job.modeVersion, 1); assert.equal(job.usePreviews, false);
    assert.deepEqual(job.directories, positions); assert.equal(job.files[0].state, 'done');
    await h.queue.command('mode', { id: '101', mode: 'videos' });
    const restored = decodeState(encodeState({ entries: [...h.saved.values()], history: [], settings: {} }, '1.4.2')).data;
    const next = setup(restored.entries); await next.queue.ready;
    assert.equal(next.saved.get('101').job.mode, 'videos');
  }
});

test('completed photo-only VK job can start the previously untouched video list later', async () => {
  const e = entry('vk', 101, 'photos-auto'); e.job.files = e.job.files.filter(f => f.kind === 'photo');
  e.job.directories[1].state = 'pending'; e.job.directories[1].cursor = null;
  const h = setup([e]); let requests = 0;
  h.deps.vk.nextPage = async (_job, _signal, _notice, dir) => {
    assert.equal(dir.mediaType, 'video'); requests++;
    return { files: [], cursor: null, empty: true };
  };
  await h.queue.command('resumeAll'); await h.queue.waitUntilIdle();
  assert.equal(requests, 0); assert((await h.queue.command('status')).jobs[0].completed);
  await h.queue.command('mode', { id: '101', mode: 'auto' });
  assert((await h.queue.command('status')).jobs[0].resumable);
  await h.queue.command('resumeAll'); await h.queue.waitUntilIdle();
  assert.equal(requests, 1); assert.equal(h.written.length, 1);
});
