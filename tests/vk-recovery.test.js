import test from 'node:test';
import assert from 'node:assert/strict';
import { handleVkRequest } from '../photo_downloader_smnv/vk-browser.js';
import { createVkProvider } from '../photo_downloader_smnv/vk-provider.js';
import { newJob } from '../photo_downloader_smnv/core.js';

const link = 'https://vk.ru/im/convo/101';
const cursor = { cmid: 1234, position: 2 };
const signal = () => new AbortController().signal;
function harness({ tabs = [{ id: 1, url: link, status: 'complete' }], script } = {}) {
  let time = 0;
  const calls = [], reloads = [];
  const browser = { tabs: {
    query: async () => tabs,
    get: async id => { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('closed'); return tab; },
    reload: async id => {
      reloads.push(id);
      Object.assign(await browser.tabs.get(id), { status: 'complete', discarded: false, frozen: false });
    }
  }, scripting: { executeScript: async args => {
    const request = args.args[0]; calls.push({ tabId: args.target.tabId, request });
    return [{ result: await script?.(args.target.tabId, request, reloads) || { ok: true, value: { title: 'Чат', items: [] } } }];
  } } };
  const timing = { now: () => time, sleep: async ms => { time += ms; } };
  return { browser, calls, reloads, tabs, timing,
    send: async message => ({ ok: true, value: await handleVkRequest(message, browser, timing) }) };
}

test('twenty dialogues automatically recover expired sessions and repeat their own saved cursors', async () => {
  const tabs = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, url: `https://vk.ru/im/convo/${101 + i}`, status: 'complete' }));
  const h = harness({ tabs, script: (id, request, reloads) => {
    if (request.action === 'page' && !reloads.includes(id)) return { ok: false, vkSession: true, recoverable: true, error: 'expired' };
  } });
  const vk = createVkProvider({ send: h.send, sleep: async () => {} });
  const jobs = tabs.map(tab => ({ ...newJob(tab.url), vkCursor: { cmid: 2000 + tab.id, position: tab.id }, vkStartCmid: 3000 }));
  await Promise.all(jobs.map(job => vk.prepare(job, signal())));
  await Promise.all(jobs.map(async job => {
    const before = structuredClone(job);
    assert((await vk.nextPage(job, signal())).empty);
    assert.deepEqual(job, before); // only the runner commits the resulting page
  }));
  assert.deepEqual(h.reloads, tabs.map(t => t.id));
  for (const tab of tabs) {
    const requests = h.calls.filter(c => c.tabId === tab.id && c.request.action === 'page');
    assert.equal(requests.length, 3); // failed, recovered, empty-page confirmation
    assert(requests.every(c => c.request.peerId === 100 + tab.id && c.request.startCmid === 3000));
    assert(requests.every(c => c.request.cursor.cmid === 2000 + tab.id && c.request.cursor.position === tab.id));
  }
});

test('discarded and frozen tabs wake on demand, without resetting video pagination or changing focus', async () => {
  for (const state of ['discarded', 'frozen']) {
    const h = harness({ tabs: [{ id: 1, url: link, status: 'complete', active: false, [state]: true }] });
    const result = await handleVkRequest({ link, action: 'page', tabId: 1, cursor, mediaType: 'video', startCmid: 9999 }, h.browser, h.timing);
    assert(result.ok); assert(result.recoveryAttempted); assert.deepEqual(h.reloads, [1]);
    assert.equal(h.tabs[0].active, false);
    assert.deepEqual(h.calls.map(c => c.request.action), ['ready', 'page']);
    assert.deepEqual(h.calls.at(-1).request, { action: 'page', peerId: 101, cursor, mediaType: 'video', startCmid: 9999 });
  }
});

test('a manual page refresh waits for the page and session to become ready without another reload', async () => {
  const h = harness({ tabs: [{ id: 1, url: link, status: 'loading' }], script: (_id, request) => {
    if (request.action === 'ready' && h.calls.length < 2) return { ok: false, recoverable: true, error: 'app loading' };
  } });
  const sleep = h.timing.sleep;
  h.timing.sleep = async ms => { await sleep(ms); h.tabs[0].status = 'complete'; };
  const result = await handleVkRequest({ link, action: 'page', tabId: 1, cursor }, h.browser, h.timing);
  assert(result.ok); assert.deepEqual(h.reloads, []);
  assert.deepEqual(h.calls.map(c => c.request.action), ['ready', 'ready', 'page']);
});

test('persistent auth failure reloads once, access denial never reloads, and errors do not expose page secrets', async () => {
  for (const recoverable of [true, false]) {
    const h = harness({ script: (_id, request) => request.action === 'page' ?
      { ok: false, vkSession: true, recoverable, error: 'access denied' } : undefined });
    const vk = createVkProvider({ send: h.send, sleep: async () => {} }); const job = newJob(link);
    await vk.prepare(job, signal());
    await assert.rejects(vk.nextPage(job, signal()), /access denied/);
    assert.equal(h.reloads.length, recoverable ? 1 : 0);
  }
  const h = harness({ script: () => { throw new Error('PRIVATE_PAGE_DATA'); } });
  const result = await handleVkRequest({ link, action: 'prepare' }, h.browser, h.timing);
  assert(result.recoverable); assert(!JSON.stringify(result).includes('PRIVATE'));
});

test('logged-out page stops after bounded readiness checks; closed or navigated tabs are never reloaded', async () => {
  const h = harness({ script: () => ({ ok: false, vkSession: true, recoverable: true, error: 'sign in' }) });
  const vk = createVkProvider({ send: h.send, sleep: async () => {} });
  await assert.rejects(vk.prepare(newJob(link), signal()), /Проверьте вход/);
  assert.deepEqual(h.reloads, [1]); assert(h.calls.length <= 41);
  for (const tabs of [[], [{ id: 1, url: 'https://vk.ru/im/convo/102' }],
    [{ id: 1, url: link, pendingUrl: 'https://vk.ru/feed' }]]) {
    const h = harness({ tabs });
    const result = await handleVkRequest({ link, action: 'page', tabId: 1, recover: true, cursor }, h.browser, h.timing);
    assert(result.vkSession); assert.deepEqual(h.reloads, []); assert.deepEqual(h.calls, []);
  }
});

test('pause after an expired-session response prevents automatic recovery', async () => {
  const controller = new AbortController(); let calls = 0;
  const vk = createVkProvider({ sleep: async () => {}, send: async () => {
    calls++; controller.abort();
    return { ok: true, value: { ok: false, recoverable: true, tabId: 1, error: 'expired' } };
  } });
  await assert.rejects(vk.prepare(newJob(link), controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});


test('slow recovery does not occupy the metadata lane and simultaneous callers share it', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let recovered = false, recoverCalls = 0, activeApi = 0, maxApi = 0;
  const vk = createVkProvider({ sleep: async () => {}, send: async message => {
    if (message.action === 'recover') {
      recoverCalls++; entered(); await blocked; recovered = true;
      return { ok: true, value: { ok: true, tabId: 1, value: { title: 'Chat' } } };
    }
    activeApi++; maxApi = Math.max(maxApi, activeApi);
    await Promise.resolve(); activeApi--;
    const failed = message.link === link && message.action === 'page' && !recovered;
    return { ok: true, value: failed ? { ok: false, tabId: 1, recoverable: true, error: 'expired' } :
      { ok: true, tabId: message.link === link ? 1 : 2, value: { title: 'Chat', items: [] } } };
  } });
  const a = newJob(link), b = newJob('https://vk.ru/im/convo/102');
  await vk.prepare(a, signal()); await vk.prepare(b, signal());
  const first = vk.nextPage(a, signal()), second = vk.nextPage(a, signal());
  await started;
  try {
    await vk.nextPage(b, signal());
    assert.equal(recovered, false); assert.equal(recoverCalls, 1);
  } finally { release(); }
  await Promise.all([first, second]); assert.equal(maxApi, 1); assert.equal(recoverCalls, 1);
});

test('deferred loading check returns immediately; recovery only checks readiness and preserves manual reload', async () => {
  const h = harness({ tabs: [{ id: 1, url: link, status: 'loading' }] });
  const result = await handleVkRequest({ link, action: 'page', tabId: 1, cursor, deferRecovery: true }, h.browser, h.timing);
  assert.equal(result.recoverable, true); assert.equal(result.reloadRequired, false); assert.equal(h.calls.length, 0);
  h.tabs[0].status = 'complete';
  const ready = await handleVkRequest({ link, action: 'recover', tabId: 1, recover: false }, h.browser, h.timing);
  assert.equal(ready.ok, true); assert.deepEqual(h.calls.map(call => call.request.action), ['ready']); assert.deepEqual(h.reloads, []);
});

test('pause during recovery never sends a resumed metadata request', async () => {
  const controller = new AbortController(); const actions = [];
  const vk = createVkProvider({ sleep: async () => {}, send: async message => {
    actions.push(message.action);
    if (message.action === 'recover') controller.abort();
    return { ok: true, value: { ok: message.action === 'recover', recoverable: true, tabId: 1, error: 'expired', value: {} } };
  } });
  await assert.rejects(vk.prepare(newJob(link), controller.signal), { name: 'AbortError' });
  assert.deepEqual(actions, ['prepare', 'recover']);
});


test('tab readiness work is limited to two concurrent recoveries', async () => {
  let release, entered; const blocked = new Promise(resolve => { release = resolve; });
  const twoStarted = new Promise(resolve => { entered = resolve; });
  let active = 0, peak = 0, started = 0; const recovered = new Set();
  const vk = createVkProvider({ sleep: async () => {}, send: async message => {
    if (message.action === 'recover') {
      active++; peak = Math.max(peak, active); if (++started === 2) entered();
      await blocked; recovered.add(message.link); active--;
    }
    return { ok: true, value: { ok: message.action === 'recover' || recovered.has(message.link), tabId: 1,
      recoverable: true, error: 'expired', value: { title: 'Chat' } } };
  } });
  const pending = Array.from({ length: 6 }, (_, i) => vk.prepare(newJob('https://vk.ru/im/convo/' + (101+i)), signal()));
  await twoStarted;
  try { assert.equal(started, 2); assert.equal(active, 2); } finally { release(); }
  await Promise.all(pending); assert.equal(peak, 2); assert.equal(started, 6);
});
