import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseLink, newJob } from '../extension/core.js';
import { parseVkLink, vkMediaUrl, vkVideoUrl, vkPhotosLink, inspectVkPage, consumeVkPage, photoResource,
  videoResource, allowedVkVideo, ensureVkDirectories, stampVkLinks } from '../extension/vk.js';
import { vkPageRequest } from '../extension/vk-page.js';
import { handleVkRequest } from '../extension/vk-browser.js';
import { createVkProvider } from '../extension/vk-provider.js';
import { createRunner } from '../extension/runner.js';
import { createQueue } from '../extension/queue.js';
import { decodeState, encodeState } from '../extension/portable-state.js';

const link = 'https://vk.ru/im/convo/101';
const media = n => `https://sun9-81.vkuserphoto.ru/photos/${n}.jpg?quality=95`;
// Shape/dimensions based on the supplied response; synthetic identifiers/URLs.
const item = (cmid, position = 1, id = cmid) => ({ cmid, position,
  attachment: { type: 'photo', photo: { owner_id: 123, id,
    orig_photo: { width: 1178, height: 2560, type: 'base', url: media(id) },
    sizes: [{ type: 'm', width: 160, height: 348, url: media(id) + '&size=m' },
      { type: 'z', width: 1178, height: 2560, url: media(id) + '&size=z' }] } } });
const signal = () => new AbortController().signal;

test('VK links canonicalize aliases, legacy chats and viewer URLs without leaking query parameters', () => {
  for (const url of [link + '?entrypoint=unknown&z=photo123_44/key', 'https://vk.com/im?sel=101', 'https://www.vk.ru/im/convo/101']) {
    assert.deepEqual(parseLink(url), { provider: 'vk', peerId: 101, publicUrl: link, path: '/' });
  }
  assert.equal(parseVkLink('https://vk.com/im?sel=c15').peerId, 2000000015);
  for (const url of ['https://vk.ru/feed', 'https://vk.ru/im', 'http://vk.ru/im/convo/1', 'https://vk.ru.evil/im/convo/1',
    'https://vk.ru@evil/im/convo/1', 'https://vk.ru:999/im/convo/1', 'https://vk.ru/im/convo/0']) assert.equal(parseVkLink(url), null);
});

test('media URL validation rejects arbitrary hosts, credentials, insecure URLs and misleading suffixes', () => {
  assert.equal(vkMediaUrl(media(1)), media(1));
  for (const url of ['https://evil.test/photo.jpg', 'https://vkuserphoto.ru.evil.test/a', 'http://sun9.vkuserphoto.ru/a',
    'https://user:secret@sun9.vkuserphoto.ru/a', 'https://sun9.vkuserphoto.ru:123/a']) assert.throws(() => vkMediaUrl(url));
});

test('separate original and preview; never upgrade a preview to original', () => {
  const a = item(100); const photo = photoResource(a);
  assert.equal(photo.vk.original.url, media(100));
  assert.equal(photo.vk.preview.url, media(100) + '&size=z');
  assert.equal(photo.local, 'photo123_100.jpg');
  delete a.attachment.photo.orig_photo;
  assert.equal(photoResource(a).vk.original, null);
});

test('pagination uses last cmid AND position, supports multiple photos per message and deduplicates IDs', () => {
  const job = newJob(link);
  consumeVkPage(job, inspectVkPage({ items: [item(100, 3, 1), item(100, 2, 2)] }));
  assert.deepEqual(job.vkCursor, { cmid: 100, position: 2 });
  consumeVkPage(job, inspectVkPage({ items: [item(100, 1, 2), item(99, 1, 3)] }, job.vkCursor));
  assert.equal(job.files.length, 3);
  assert.equal(job.directories[0].state, 'pending'); // short pages are not EOF
  consumeVkPage(job, inspectVkPage({ items: [] }, job.vkCursor));
  assert.equal(job.directories[0].state, 'done');
});

test('malformed and repeated pages never advance a persisted cursor', () => {
  const cursor = { cmid: 100, position: 1 };
  for (const response of [{}, { items: [item(100)] }, { items: [item(101)] }, { items: [{ cmid: 99 }] }]) {
    assert.throws(() => inspectVkPage(response, cursor));
    assert.deepEqual(cursor, { cmid: 100, position: 1 });
  }
});

function pageContext(response, extra = {}) {
  let captured;
  const context = vm.createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    location: { href: link }, window: { vk: { id: 123, webToken: { access_token: 'TEST_SESSION_TOKEN' } } },
    document: { querySelector: () => ({ textContent: 'Тестовый диалог' }) },
    fetch: async (url, options) => { captured = { url, options }; return Response.json(response); }, ...extra });
  const call = request => vm.runInContext(`(${vkPageRequest.toString()})(${JSON.stringify({ peerId: 101, ...request })})`, context);
  return { call, captured: () => captured };
}

test('page bridge uses current session only in POST body and returns only download metadata', async () => {
  const raw = item(99); raw.from_id = 111; raw.attachment.photo.text = 'PRIVATE MESSAGE'; raw.attachment.photo.access_key = 'PRIVATE_KEY';
  const h = pageContext({ response: { items: [raw], profiles: [{ first_name: 'Private' }] } });
  const result = await h.call({ action: 'page', cursor: { cmid: 100, position: 2 } });
  assert(result.ok);
  const p = h.captured().options.body;
  assert.equal(p.get('access_token'), 'TEST_SESSION_TOKEN');
  assert.equal(p.get('cmid'), '100'); assert.equal(p.get('attachment_position'), '2');
  assert.equal(p.get('offset'), '1'); assert.equal(p.get('count'), '30'); assert.equal(p.get('attachment_types'), 'photo');
  assert(!h.captured().url.includes('TOKEN'));
  assert(!/TOKEN|PRIVATE|profiles|from_id/.test(JSON.stringify(result)));
});

test('initial page does not reuse a user scroll cursor; expired session and API error never expose secrets', async () => {
  const h = pageContext({ response: { items: [] } });
  await h.call({ action: 'page' });
  assert.equal(h.captured().options.body.get('cmid'), null);
  assert.equal(h.captured().options.body.get('offset'), '0');
  const bad = await pageContext({ error: { error_code: 5, error_msg: 'SECRET', request_params: ['SECRET'] } }).call({ action: 'page' });
  assert(bad.vkSession); assert(!JSON.stringify(bad).includes('SECRET'));
  const wrong = await pageContext({}, { location: { href: 'https://vk.ru/im/convo/7' } }).call({ action: 'page' });
  assert(wrong.vkSession);
  const loggedOut = await pageContext({}, { window: {} }).call({ action: 'prepare' });
  assert(loggedOut.vkSession);
});

test('browser reuses exact dialog tab; pasted link opens one; navigation pauses without reading another dialog', async () => {
  const calls = [], tabs = [{ id: 2, url: link, status: 'complete' }];
  const browser = { tabs: { query: async () => tabs, get: async () => tabs[0],
    create: async args => { calls.push(['create', args]); return { id: 3, url: args.url, status: 'complete' }; } },
    scripting: { executeScript: async args => { calls.push(['script', args]); return [{ result: { ok: true, value: { title: 'Тестовый диалог' } } }]; } } };
  const ready = await handleVkRequest({ link, action: 'prepare' }, browser);
  assert.equal(ready.tabId, 2); assert.equal(calls.length, 1); assert.equal(calls[0][1].world, 'MAIN');
  tabs[0].url = 'https://vk.ru/im/convo/9';
  assert((await handleVkRequest({ link, action: 'page', tabId: 2 }, browser)).vkSession);
  assert.equal(calls.length, 1);
  await handleVkRequest({ link, action: 'prepare' }, browser);
  assert.equal(calls[1][0], 'create');
});

test('provider retries throttling/stalled pages on the same cursor and confirms empty pages', async () => {
  const cursors = [], delays = [], notices = [];
  const results = [ { ok: false, retryable: true, error: 'slow' },
    { ok: true, value: { items: [item(100)] } }, { ok: true, value: { items: [item(90)] } },
    { ok: true, value: { items: [] } }, { ok: true, value: { items: [item(80)] } } ];
  const vk = createVkProvider({ sleep: async ms => delays.push(ms), send: async m => {
    cursors.push(m.cursor); return { ok: true, value: { ...results.shift(), tabId: 2 } };
  } });
  const job = { ...newJob(link), vkCursor: { cmid: 100, position: 1 } };
  const page = await vk.nextPage(job, signal(), text => notices.push(text));
  assert.equal(page.cursor.cmid, 90); assert.equal(cursors.length, 3);
  assert(cursors.every(c => c === job.vkCursor)); assert.equal(notices.filter(text => text.includes('Повтор через')).length, 2);
  assert(notices.some(text => text.includes('очередь запросов')));
  job.vkCursor = page.cursor;
  assert.equal((await vk.nextPage(job, signal())).cursor.cmid, 80);
  assert(delays.every(ms => ms <= 1000));
});

test('provider bounds retries, cancellation, and refreshes expired URLs by exact attachment', async () => {
  let calls = 0;
  const vk = createVkProvider({ sleep: async () => {}, send: async () => { calls++; return { ok: true, value: { ok: true, tabId: 2, value: { items: [item(100)] } } }; } });
  await assert.rejects(vk.nextPage({ ...newJob(link), vkCursor: { cmid: 100, position: 1 } }, signal()), /повторяет/);
  assert.equal(calls, 4);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(vk.nextPage(newJob(link), controller.signal)); assert.equal(calls, 4);
  let reads = 0;
  const refresh = createVkProvider({ sleep: async () => {}, send: async m => {
    assert.equal(m.action, 'photo'); assert.deepEqual(m.cursor, { cmid: 100, position: 1 });
    return { ok: true, value: { ok: true, tabId: 2, value: { items: [item(100)] } } };
  }, fetchImage: async url => { if (++reads === 1) throw Object.assign(new Error('expired'), { status: 403 }); assert.equal(url, media(100)); return new Blob(['abc']); } });
  assert.equal((await refresh.getPhoto(newJob(link), photoResource(item(100)), 'original', signal())).size, 3);
  assert.equal(reads, 2);
});

test('metadata requests from different dialogs are serialized and paced', async () => {
  let active = 0, max = 0, waits = 0;
  const vk = createVkProvider({ sleep: async () => { waits++; }, send: async () => {
    active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { ok: true, value: { ok: true, tabId: 2, value: { title: 'Test' } } };
  } });
  await Promise.all([vk.prepare(newJob(link), signal()), vk.prepare(newJob('https://vk.ru/im/convo/7'), signal())]);
  assert.equal(max, 1); assert(waits >= 4);
});

function runnerHarness(overrides = {}) {
  let saved, pages = 0; const events = [], receipts = new Map();
  const deps = { loadJob: async () => null, saveJob: async job => { saved = structuredClone(job); },
    loadHistory: async key => receipts.get(key), saveHistory: async (key, value) => receipts.set(key, value),
    verifyLocal: async record => record, sleep: async () => {},
    vk: { prepare: async () => ({ title: 'Тестовый диалог' }), nextPage: async (job, _signal, _notice, dir) => {
      if (dir.mediaType === 'video') return inspectVkPage({ items: [] }, dir.cursor, 'video');
      events.push('page'); return inspectVkPage({ items: pages++ < 2 ? [item(100 - pages)] : [] }, job.vkCursor);
    } },
    resource: async () => { throw new Error('Yandex must not be called'); },
    getPhoto: async (_job, file, kind) => { events.push(kind + ':' + file.path); return new Blob(['abc'], { type: 'image/jpeg' }); },
    saveLocal: async (path, blob) => { events.push('save:' + path); return { savedPath: path, savedBytes: blob.size, localFile: true }; }, ...overrides };
  return { runner: createRunner(deps), events, saved: () => saved, deps, receipts };
}

test('runner discovers independently, persists folder/cursor, and resumes/reuses unknown-size VK photos', async () => {
  const h = runnerHarness();
  await h.runner.command('scan', { link }); await h.runner.waitUntilIdle();
  assert.deepEqual(h.events.map(e => e.split(':')[0]), ['page', 'page', 'page', 'original', 'save', 'original', 'save']);
  assert.equal(h.saved().folder, 'vk-messager/Тестовый диалог'); assert.equal(h.saved().phase, 'done');
  assert.equal(h.saved().files.length, 2);
  const job = h.saved(); job.files.forEach(f => { f.state = 'pending'; });
  const second = createRunner({ ...h.deps, loadJob: async () => job });
  await second.command('start'); await second.waitUntilIdle();
  assert.equal(h.events.filter(e => e.startsWith('save:')).length, 2);
  assert.equal((await second.command('status')).job.summary.reused, 2);
});

test('runner pause retains active and prefetched files, restart saves each once', async () => {
  let reached = false;
  const h = runnerHarness({ getPhoto: async (_j, _f, _k, s) => {
    reached = true; await new Promise((resolve, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true }));
  } });
  await h.runner.command('scan', { link });
  for (let i = 0; i < 100 && !reached; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert(reached); await h.runner.command('pause'); await h.runner.waitUntilIdle();
  const job = h.saved(); assert.equal(job.files[0].state, 'pending'); assert.equal(h.events.filter(e => e === 'page').length, 3);
  h.events.length = 0;
  const resumed = createRunner({ ...h.deps, loadJob: async () => job, getPhoto: async () => new Blob(['abc']) });
  await resumed.command('start'); await resumed.waitUntilIdle();
  assert.equal(h.events.filter(e => e.startsWith('save:')).length, 2);
  assert.equal(h.saved().files.length, 2); assert.equal(h.saved().phase, 'done');
});

test('auto mode falls back to preview but continues trying each original; original-only never falls back', async () => {
  for (const mode of ['auto', 'original']) {
    const kinds = [];
    let first = true;
    const h = runnerHarness({ vk: { prepare: async () => ({ title: 'Test' }), nextPage: async job => {
      const items = first ? [item(100), item(99), item(98), item(97)] : []; first = false;
      return inspectVkPage({ items }, job.vkCursor);
    } }, getPhoto: async (_job, _file, kind) => { kinds.push(kind); if (kind === 'original') throw new Error('No original'); return new Blob(['abc']); } });
    await h.runner.command('scan', { link, mode }); await h.runner.waitUntilIdle();
    assert.equal(kinds.filter(k => k === 'original').length, 4);
    assert.equal(kinds.filter(k => k === 'preview').length, mode === 'auto' ? 4 : 0);
    if (mode === 'auto') assert(h.saved().files.every(f => f.savedPath.includes('.preview.')));
  }
});

test('session failure pauses instead of falling back/skipping remaining photos; stalled pagination remains resumable', async () => {
  const h = runnerHarness({ getPhoto: async () => { throw Object.assign(new Error('Login again'), { vkSession: true }); } });
  await h.runner.command('scan', { link }); await h.runner.waitUntilIdle();
  assert.equal(h.saved().files[0].state, 'pending'); assert.notEqual(h.saved().phase, 'done');
  assert.equal(h.events.filter(e => e === 'page').length, 3);
  let saved;
  const queue = createQueue({ ...h.deps, loadEntries: async () => [], saveEntry: async e => { saved = e; },
    vk: { prepare: async () => ({ title: 'Test' }), nextPage: async () => { throw new Error('Pagination stopped'); } } });
  await queue.command('scan', { link }); await queue.waitUntilIdle();
  const status = await queue.command('status');
  assert.equal(status.jobs[0].resumable, true); assert.equal(status.jobs[0].completed, false);
  assert.equal(saved.job.directories[0].state, 'pending');
});

test('portable database round-trips both providers and rejects mismatched source/folder', () => {
  const vk = newJob(link); vk.title = 'Тестовый диалог'; vk.folder = 'vk-messager/' + vk.title;
  consumeVkPage(vk, inspectVkPage({ items: [item(100)] }));
  const state = { entries: [{ id: 'vk', job: vk }, { id: 'ya', job: newJob('https://disk.yandex.ru/d/test') }], history: [], settings: {} };
  const data = decodeState(encodeState(state, '1.4.0')).data;
  assert.deepEqual(data.entries[0].job.vkCursor, { cmid: 100, position: 1 });
  assert.equal(data.entries[0].job.folder, vk.folder);
  state.entries[0].job.folder = 'yandex-disk/Test';
  assert.throws(() => decodeState(encodeState(state, '1.4.0')));
});

const videoItem = (cmid, title = 'Видео от Тестового пользователя', files = { mp4_360: 'https://vkvd360.okcdn.ru/?quality=360', mp4_720: 'https://vkvd360.okcdn.ru/?quality=720' }) => ({ cmid, position: 1,
  attachment: { type: 'video', video: { owner_id: 123, id: cmid, title, files } } });
const videoTitles = ['Видео от Тестового пользователя', 'Видео от Тестового собеседника'];

test('plain conversation builds a photo panel link and initializes from latest message without any panel', async () => {
  assert.equal(vkPhotosLink('https://vk.ru/im/convo/202?entrypoint=list_all'), 'https://vk.ru/im/convo/202?rp=peer202');
  const methods = [];
  const h = pageContext(null, { fetch: async (url, options) => {
    const method = new URL(url).pathname.split('/').at(-1); methods.push(method);
    assert.equal(options.body.get('peer_id'), '101');
    if (method === 'messages.getHistory') {
      assert.equal(options.body.get('count'), '1');
      return Response.json({ response: { items: [{ conversation_message_id: 140900, text: 'private message' }] } });
    }
    assert.equal(options.body.get('cmid'), '140900'); assert.equal(options.body.get('offset'), '0');
    assert.equal(options.body.get('attachment_types'), 'photo');
    return Response.json({ response: { items: [item(100)] } });
  } });
  const result = await h.call({ action: 'page' });
  assert(result.ok); assert.equal(result.value.startCmid, 140900);
  assert.deepEqual(methods, ['messages.getHistory', 'messages.getHistoryAttachments']);
  assert(!JSON.stringify(result).includes('private message'));
});

test('prepare works in a group chat without requesting participant names', async () => {
  const h = pageContext(null, { location: { href: 'https://vk.ru/im/convo/2000000015' },
    document: { querySelector: () => ({ textContent: 'Общий чат' }) },
    fetch: async () => { throw new Error('No API call expected'); } });
  const result = await h.call({ action: 'prepare', peerId: 2000000015 });
  assert(result.ok); assert.equal(result.value.title, 'Общий чат');
  assert.equal(result.value.videoTitles, undefined);
  assert(!JSON.stringify(result).includes('TEST_SESSION_TOKEN'));
});

test('video page bridge uses video payload and returns MP4 fields without player or credentials', async () => {
  const video = videoItem(99); video.attachment.video.player = 'https://youtube.com/private'; video.attachment.video.access_key = 'PRIVATE';
  video.attachment.video.files.hls = 'https://vkvd360.okcdn.ru/playlist.m3u8';
  const h = pageContext({ response: { items: [video] } });
  const result = await h.call({ action: 'page', mediaType: 'video', cursor: { cmid: 100, position: 1 } });
  assert(result.ok); assert.equal(h.captured().options.body.get('attachment_types'), 'video');
  assert.equal(h.captured().options.body.get('offset'), '1');
  assert(!/youtube|player|PRIVATE|hls/.test(JSON.stringify(result)));
  assert(result.value.items[0].attachment.video.files.mp4_720);
});

test('video filter accepts the phrase Видео от with any author, but requires a native VK MP4', () => {
  const job = newJob(link); job.vkVideoTitles = videoTitles;
  const entries = [videoItem(100), videoItem(99, 'Видео от Тестового собеседника'), videoItem(98, 'Мы растем - Весна 2026.mov'),
    videoItem(97, 'Видео от Постороннего Автора'), videoItem(96, videoTitles[0], { external: 'https://youtube.com/watch?v=1' }),
    videoItem(95, videoTitles[0], { mp4_1080: 'https://youtube.com/fake.mp4' }),
    videoItem(94, videoTitles[0], { hls_ondemand: 'https://vkvd360.okcdn.ru/video.m3u8' })];
  consumeVkPage(job, inspectVkPage({ items: entries }, null, 'video'), job.directories[1]);
  assert.deepEqual(job.files.map(f => f.state), ['pending', 'pending', 'skipped', 'pending', 'skipped', 'skipped', 'skipped']);
  assert.equal(job.files[0].vk.video.quality, 720);
  assert.equal(job.files[0].local, 'video123_100.mp4');
  assert(allowedVkVideo(videoResource(videoItem(1, ' Видео от Тестового пользователя ')), videoTitles));
  assert(allowedVkVideo(videoResource(videoItem(1, 'Архив: ВИДЕО   ОТ Другого автора — копия'))));
  for (const title of ['Видео отпуск', 'супервидео от автора', 'Мой ролик', 'Видео отправлено']) {
    assert(!allowedVkVideo(videoResource(videoItem(1, title))));
  }
  for (const url of ['https://youtube.com/a.mp4', 'https://okcdn.ru.evil.test/a.mp4', 'http://vkvd360.okcdn.ru/a', 'https://vk.ru/video1_1']) assert.throws(() => vkVideoUrl(url));
});

test('photo and video cursors stay independent and old photo-only jobs gain a resumable video pass', () => {
  const job = newJob(link);
  consumeVkPage(job, inspectVkPage({ items: [item(100)] }), job.directories[0]);
  consumeVkPage(job, inspectVkPage({ items: [videoItem(200)] }, null, 'video'), job.directories[1]);
  assert.equal(job.directories[0].cursor.cmid, 100); assert.equal(job.directories[1].cursor.cmid, 200);
  assert.equal(job.vkCursor.cmid, 100);
  job.directories.pop(); job.directories[0].state = 'done'; job.phase = 'done';
  ensureVkDirectories(job);
  assert.equal(job.phase, 'ready'); assert.equal(job.directories[0].state, 'done');
  assert.equal(job.directories[1].state, 'pending'); assert.equal(job.directories[1].cursor, null);
});

test('runner reads both lists independently, skipping filtered videos', async () => {
  const events = []; const h = runnerHarness({ vk: { prepare: async () => ({ title: 'Test', videoTitles }),
    nextPage: async (job, _signal, _notice, dir) => {
      events.push('page:' + dir.mediaType);
      const items = dir.cursor ? [] : dir.mediaType === 'photo' ? [item(100)] : [videoItem(100), videoItem(99, 'Custom title')];
      return inspectVkPage({ items }, dir.cursor, dir.mediaType);
    } },
    getPhoto: async () => { events.push('photo'); return new Blob(['photo']); },
    getOriginalUrl: async (_job, file) => { events.push('video:' + file.path); return file.vk.video.url; },
    saveLocal: async (path, source, opts) => { if (path.endsWith('.mp4')) { assert(opts.direct); assert.equal(typeof source, 'string'); } return { savedPath: path, savedBytes: 12, localFile: true }; }
  });
  await h.runner.command('scan', { link }); await h.runner.waitUntilIdle();
  assert.deepEqual(events.filter(e => e === 'photo' || e === 'page:photo'), ['page:photo', 'page:photo', 'photo']);
  assert.deepEqual(events.filter(e => e.startsWith('video:') || e === 'page:video'), ['page:video', 'page:video', 'video:/video123_100']);
  assert(events.indexOf('page:video') < events.lastIndexOf('page:photo'));
  assert.equal(h.saved().files.find(f => f.path === '/video123_99').state, 'skipped');
  assert.equal(h.saved().phase, 'done');
});


test('slow batch tails do not starve photos, reserve video slots, or need UI status requests', async () => {
  const active = { photo: 0, video: 0 }, peaks = { photo: 0, video: 0 }, pages = { photo: 0, video: 0 };
  const gates = [], entered = [], writes = [];
  let releaseAll = false, saved;
  const queue = createQueue({ loadEntries: async () => [], saveEntry: async entry => { saved = structuredClone(entry.job); },
    loadSettings: async () => ({ vkDownloadLimit: 30 }),
    vk: { prepare: async () => ({ title: 'Test' }), nextPage: async (_job, _signal, _notice, dir) => {
      const page = pages[dir.mediaType]++;
      const items = dir.mediaType === 'photo'
        ? (page < 3 ? Array.from({ length: 30 }, (_, i) => item(1000 - page * 30 - i)) : [])
        : (page < 2 ? Array.from({ length: page ? 5 : 30 }, (_, i) => videoItem(2000 - page * 30 - i)) : []);
      return inspectVkPage({ items }, dir.cursor, dir.mediaType);
    } },
    getPhoto: async (_job, file, _kind, signal) => {
      entered.push(file.path); active.photo++; peaks.photo = Math.max(peaks.photo, active.photo);
      try {
        if (file.vk.cmid > 995 && !releaseAll) await new Promise((resolve, reject) => {
          gates.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return new Blob(['abc']);
      } finally { active.photo--; }
    },
    getOriginalUrl: async (_job, file) => file.vk.video.url,
    saveLocal: async (path, blob, options) => {
      if (path.endsWith('.mp4')) {
        active.video++; peaks.video = Math.max(peaks.video, active.video);
        try { if (!releaseAll) await new Promise((resolve, reject) => {
          gates.push(resolve); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        }); } finally { active.video--; }
      }
      writes.push(path); return { savedPath: path, savedBytes: 3, localFile: true };
    }
  });
  await queue.command('scan', { link });
  // No status command or popup is involved while both streams are running.
  for (let i = 0; i < 1000 && (writes.length < 85 || active.video < 10); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 85); assert.equal(active.photo, 5); assert.equal(active.video, 10);
  assert.equal(entered.length, 90); assert.equal(pages.photo, 4); assert.equal(pages.video, 3);
  assert.equal(saved.files.length, 125);
  assert(saved.directories.every(dir => dir.state === 'done'));
  assert(peaks.photo <= 20); assert.equal(peaks.video, 10);
  releaseAll = true; gates.forEach(resolve => resolve()); await queue.waitUntilIdle();
  assert.equal(saved.phase, 'done'); assert.equal(saved.files.filter(file => file.state === 'done').length, 125);
  assert.equal(new Set(writes).size, 125); assert.equal(writes.length, 125);
});

test('VK page discovery defaults to one second and accepts a selected pause', async () => {
  let elapsed = 0, id = 100;
  const started = [];
  const vk = createVkProvider({ sleep: async ms => { elapsed += ms; }, send: async () => {
    started.push(elapsed); return { ok: true, value: { ok: true, tabId: 2, value: { items: [item(id--)] } } };
  } });
  const job = newJob(link);
  await vk.nextPage(job, signal());
  await vk.nextPage(job, signal(), undefined, job.directories[0], 5000);
  // The per-page delay is additional to the shared one-second API pace.
  assert.deepEqual(started, [2000,8000]);
});

test('cached URLs retain their age when refreshed unchanged; changed URLs start a new age', () => {
  const file = photoResource(item(10)); stampVkLinks(file.vk, null, 1000);
  assert.equal(file.vk.original.receivedAt, 1000); assert.equal(file.vk.preview.receivedAt, 1000);
  const fresh = photoResource(item(10)).vk; fresh.preview.url += '&new=1';
  stampVkLinks(fresh, file.vk, 5000);
  assert.equal(fresh.original.receivedAt, 1000); assert.equal(fresh.preview.receivedAt, 5000);
  const job = newJob(link); consumeVkPage(job, inspectVkPage({ items: [item(10)] }));
  assert(Number.isFinite(job.files[0].vk.original.receivedAt));
});


test('refresh requests a batch starting inclusively at the saved attachment', async () => {
  const h = pageContext(null, { fetch: async (_url, options) => {
    assert.equal(options.body.get('count'), '30'); assert.equal(options.body.get('offset'), '0');
    assert.equal(options.body.get('cmid'), '100'); assert.equal(options.body.get('attachment_position'), '1');
    return Response.json({ response: { items: [item(100), item(99)] } });
  } });
  const result = await h.call({ action: 'photo', cursor: { cmid: 100, position: 1 } });
  assert(result.ok); assert.equal(result.value.items.length, 2);
});
