import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortableStorage, decodeState, encodeState, STATE_FILE } from '../extension/portable-state.js';
import { newJob } from '../extension/core.js';

function folder() {
  const files = new Map(); let fail = false, writes = 0;
  const root = { queryPermission: async () => 'granted', getDirectoryHandle: async () => ({
    getFileHandle: async (name, options) => {
      if (!files.has(name) && !options?.create) throw new DOMException('Missing', 'NotFoundError');
      return { getFile: async () => new Blob([files.get(name) || '']), createWritable: async () => {
        let text;
        return { write: async value => { if (fail) throw new Error('Disk full'); text = value; },
          close: async () => { writes++; files.set(name, text); }, abort: async () => {} };
      } };
    }
  }) };
  return { root, files, fail: () => { fail = true; }, get writes() { return writes; } };
}
function cache(initial = {}) {
  let state = { entries: [], history: [], settings: {}, ...structuredClone(initial) };
  return { exportState: async () => structuredClone(state), replaceState: async value => { state = structuredClone(value); },
    loadDownloadFolder: async () => null,
    saveEntry: async entry => { state.entries = state.entries.filter(e => e.id !== entry.id).concat(structuredClone(entry)); },
    saveHistory: async (key, record) => { state.history = state.history.filter(r => r[0] !== key).concat([[key, structuredClone(record)]]); },
    saveSettings: async settings => { state.settings = structuredClone(settings); },
    deleteEntry: async id => { state.entries = state.entries.filter(e => e.id !== id); }
  };
}
function entry(id = 'album') {
  return { id, wanted: true, action: 'retry', actionArgs: { includePreviews: true }, job: {
    ...newJob('https://disk.yandex.ru/d/' + id), phase: 'downloading', title: 'Album', folder: 'yandex-disk/Album',
    files: [{ name: 'a.jpg', local: 'a.jpg', path: '/a.jpg', kind: 'photo', size: 3, state: 'active', downloadId: 999 }]
  } };
}
test('JSON restores entries, errors, previews, receipts and settings with a completely new cache', async () => {
  const f = folder(), first = createPortableStorage({ cache: cache(), extensionVersion: '1.3.7' });
  await first.changeFolder(f.root);
  const e = entry(); e.overallNewFilesBaseline = 5; e.job.runNewFiles = 7; e.job.files.push(
    { name: 'b.jpg', local: 'b.jpg', path: '/b.jpg', kind: 'photo', state: 'failed', reason: 'Unavailable' },
    { name: 'c.jpg', local: 'c.jpg', path: '/c.jpg', kind: 'photo', state: 'done', savedKind: 'preview' });
  await first.saveHistory('key', { original: { savedPath: 'yandex-disk/Album/a.jpg', localFile: true, downloadId: 999 } });
  await first.saveEntry(e); await first.saveSettings({ downloadLimit: 10, timeoutSeconds: 120 });
  const text = f.files.get(STATE_FILE);
  assert.equal(JSON.parse(text).extensionVersion, '1.3.7'); assert(!text.includes('downloadId'));
  const second = createPortableStorage({ cache: cache(), extensionVersion: '1.3.8' });
  const restored = await second.changeFolder(f.root);
  assert.equal(restored.entries[0].wanted, false);
  assert.equal(restored.entries[0].job.runNewFiles, 7);
  assert.equal(restored.entries[0].overallNewFilesBaseline, 5);
  assert.equal(restored.entries[0].suspendedRetry.includePreviews, true);
  assert.deepEqual(restored.entries[0].job.files.map(f => f.state), ['pending', 'failed', 'done']);
  assert.equal(restored.entries[0].job.files[1].reason, 'Unavailable');
  assert.equal(restored.entries[0].job.files[2].savedKind, 'preview');
  assert.equal((await second.loadHistory('key')).original.localFile, true);
  assert.deepEqual(await second.loadSettings(), { downloadLimit: 10, timeoutSeconds: 120 });
  assert.equal(JSON.parse(f.files.get(STATE_FILE)).extensionVersion, '1.3.8');
});
test('migration preserves the original bytes before upgrading old job data', async () => {
  const f = folder(), e = entry(); e.job.version = 1; e.job.files[0].state = 'skipped';
  const old = encodeState({ entries: [e], settings: {}, history: [] }, '1.0.0');
  f.files.set(STATE_FILE, old);
  const store = createPortableStorage({ cache: cache(), extensionVersion: '1.3.7' });
  const restored = await store.changeFolder(f.root);
  assert.equal(restored.entries[0].job.version, 2); assert.equal(restored.entries[0].job.files[0].state, 'pending');
  const backup = [...f.files].find(([name]) => name.includes('before-migration'));
  assert.equal(backup[1], old);
});
test('future schema, invalid JSON and unsafe paths never overwrite the original or replace the current state', async () => {
  const f = folder(), store = createPortableStorage({ cache: cache({ entries: [entry('current')] }), extensionVersion: '1.3.7' });
  const valid = JSON.parse(encodeState({ entries: [entry()], settings: {}, history: [] }, '1.3.7'));
  const unsafe = structuredClone(valid); unsafe.entries[0].job.files[0].local = '../escape';
  for (const text of ['{broken', JSON.stringify({ ...valid, schemaVersion: 99 }), JSON.stringify(unsafe)]) {
    f.files.set(STATE_FILE, text);
    await assert.rejects(store.changeFolder(f.root));
    assert.equal(f.files.get(STATE_FILE), text); assert.equal(f.writes, 0);
    assert.equal((await store.loadEntries())[0].id, 'current');
  }
});
test('parallel checkpoints keep every job and deletion persists without deleting history', async () => {
  const f = folder(), store = createPortableStorage({ cache: cache(), extensionVersion: '1.3.7' });
  await store.changeFolder(f.root);
  await Promise.all(Array.from({ length: 50 }, (_, i) => store.saveEntry(entry('job' + i))));
  assert.equal(JSON.parse(f.files.get(STATE_FILE)).entries.length, 50);
  await store.saveHistory('keep', { preview: { localFile: true } });
  await store.deleteEntry('job0');
  const data = JSON.parse(f.files.get(STATE_FILE));
  assert.equal(data.entries.length, 49); assert.equal(data.history[0][0], 'keep');
  assert(f.writes < 10, 'simultaneous mutations should be coalesced');
});
test('failed writes retain the previous JSON and prevent further download preparation', async () => {
  const f = folder(), store = createPortableStorage({ cache: cache(), extensionVersion: '1.3.7' });
  await store.changeFolder(f.root); const original = f.files.get(STATE_FILE); f.fail();
  await assert.rejects(store.saveEntry(entry()), error => error.localAccess);
  assert.equal(f.files.get(STATE_FILE), original);
  await assert.rejects(store.prepare(f.root), error => error.localAccess);
});
test('startup reads JSON instead of a stale browser cache and keeps work stopped', async () => {
  const f = folder();
  f.files.set(STATE_FILE, encodeState({ entries: [entry('disk')], history: [], settings: { timeoutSeconds: 60 } }, '1.3.7'));
  const local = cache({ entries: [entry('stale')] }); local.loadDownloadFolder = async () => f.root;
  const store = createPortableStorage({ cache: local, extensionVersion: '1.3.7' });
  await store.ready;
  assert.equal((await store.loadEntries())[0].id, 'disk');
  assert.equal((await store.loadEntries())[0].wanted, false);
  assert.equal((await local.exportState()).entries[0].id, 'disk');
});
test('revoked directory access prevents unsaved settings and deletions until reconnect', async () => {
  const f = folder(), local = cache({ entries: [entry()] });
  let allowed = false; f.root.queryPermission = async () => allowed ? 'granted' : 'prompt';
  local.loadDownloadFolder = async () => f.root;
  const store = createPortableStorage({ cache: local, extensionVersion: '1.3.7' });
  await store.ready;
  assert(store.error);
  await assert.rejects(store.deleteEntry('album'), error => error.localAccess);
  await assert.rejects(store.saveSettings({ downloadLimit: 50 }), error => error.localAccess);
  allowed = true; await store.changeFolder(f.root);
  assert.equal(store.error, null);
  assert.equal(JSON.parse(f.files.get(STATE_FILE)).entries.length, 1);
});
test('an archive of 25000 files round-trips without losing late errors or preview flags', async () => {
  const f = folder(), store = createPortableStorage({ cache: cache(), extensionVersion: '1.3.7' });
  await store.changeFolder(f.root);
  const e = entry();
  e.job.files = Array.from({ length: 25000 }, (_, n) => ({
    name: `${n}.jpg`, local: `${n}.jpg`, path: `/${n}.jpg`, kind: 'photo', size: 100,
    state: n === 24999 ? 'failed' : 'done', savedKind: n % 5 ? 'original' : 'preview', reason: n === 24999 ? 'Server unavailable' : ''
  }));
  await store.saveEntry(e);
  const restored = decodeState(f.files.get(STATE_FILE)).data.entries[0].job.files;
  assert.equal(restored.length, 25000); assert.equal(restored.at(-1).reason, 'Server unavailable');
  assert.equal(restored.filter(file => file.savedKind === 'preview').length, 5000);
});


test('a corrupt browser cache cannot block a valid JSON database on startup', async () => {
  const f = folder(); f.files.set(STATE_FILE, encodeState({ entries: [entry('disk')], history: [], settings: {} }, '1.5.7'));
  const local = cache({ entries: [null] }); local.loadDownloadFolder = async () => f.root;
  const store = createPortableStorage({ cache: local, extensionVersion: '1.5.7' });
  await store.ready; assert.equal(store.error, null); assert.equal((await store.loadEntries())[0].id, 'disk');
});

test('corrupt browser cache and corrupt JSON report a recoverable error without overwriting either', async () => {
  const f = folder(); const broken = '\0'.repeat(100); f.files.set(STATE_FILE, broken);
  const local = cache({ entries: [null] }); local.loadDownloadFolder = async () => f.root;
  const store = createPortableStorage({ cache: local, extensionVersion: '1.5.7' });
  await store.ready; assert.match(store.error.message, /повреждён/); assert.deepEqual(await store.loadEntries(), []);
  assert.equal(f.files.get(STATE_FILE), broken); assert.deepEqual((await local.exportState()).entries, [null]);
  f.files.set(STATE_FILE, encodeState({ entries: [], history: [], settings: {} }, '1.5.7'));
  await store.changeFolder(f.root); assert.equal(store.error, null);
});


test('startup restores the newest valid backup and preserves corrupt main bytes', async () => {
  const f = folder(), broken = '\0'.repeat(100);
  const old = JSON.parse(encodeState({ entries: [entry('old')], history: [], settings: {} }, '1.5.7'));
  old.updatedAt = '2026-10-22T00:00:00Z';
  const recent = { ...old, entries: [entry('recent')], updatedAt: '2026-10-23T00:00:00Z' };
  f.files.set(STATE_FILE, broken);
  f.files.set('downloader-state.backup-1.json', JSON.stringify(old));
  f.files.set('downloader-state.backup-2.json', JSON.stringify(recent));
  const local = cache(); local.loadDownloadFolder = async () => f.root;
  const store = createPortableStorage({ cache: local, extensionVersion: '1.5.7' }); await store.ready;
  assert.equal(store.error, null); assert.equal((await store.loadEntries())[0].id, 'recent');
  assert.match(store.warning, /восстановлена/);
  assert([...f.files].some(([name, text]) => name.startsWith('downloader-state.corrupt-') && text === broken));
  assert.equal(decodeState(f.files.get(STATE_FILE)).data.entries[0].id, 'recent');
});

test('a future main schema never falls back to an older backup', async () => {
  const f = folder(); const data = JSON.parse(encodeState({ entries: [entry()], history: [], settings: {} }, '1.5.7'));
  const future = JSON.stringify({ ...data, schemaVersion: 99 });
  f.files.set(STATE_FILE, future); f.files.set('downloader-state.backup-1.json', JSON.stringify(data));
  const local = cache(); local.loadDownloadFolder = async () => f.root;
  const store = createPortableStorage({ cache: local, extensionVersion: '1.5.7' }); await store.ready;
  assert.match(store.error.message, /более новой/); assert.equal(f.files.get(STATE_FILE), future); assert.equal(f.writes, 0);
});

test('backup generations rotate once per minute while regular checkpoints keep working', async () => {
  let at = 0; const f = folder(); const store = createPortableStorage({ cache: cache(), extensionVersion: '1.5.7', now: () => at });
  await store.changeFolder(f.root); await store.saveEntry(entry('one'));
  assert(!f.files.has('downloader-state.backup-2.json'));
  at = 61000; await store.saveEntry(entry('two'));
  assert.equal(decodeState(f.files.get('downloader-state.backup-2.json')).data.entries.length, 2);
  at = 62000; await store.saveEntry(entry('three'));
  assert.equal(decodeState(f.files.get('downloader-state.backup-2.json')).data.entries.length, 2);
  at = 122000; await store.saveEntry(entry('four'));
  assert.equal(decodeState(f.files.get('downloader-state.backup-1.json')).data.entries.length, 4);
  assert.equal(decodeState(f.files.get('downloader-state.backup-2.json')).data.entries.length, 2);
});


test('write verification detects a zero-filled readback and retains a valid backup', async () => {
  const f = folder(); const directory = await f.root.getDirectoryHandle();
  const getFileHandle = directory.getFileHandle;
  directory.getFileHandle = async (name, options) => {
    const handle = await getFileHandle(name, options);
    if (name === STATE_FILE) handle.getFile = async () => new Blob(['\0'.repeat(100)]);
    return handle;
  };
  f.root.getDirectoryHandle = async () => directory;
  const store = createPortableStorage({ cache: cache({ entries: [entry()] }), extensionVersion: '1.5.7' });
  await assert.rejects(store.changeFolder(f.root), error => error.localAccess && /Проверка записанного/.test(error.message));
  assert.equal(decodeState(f.files.get('downloader-state.backup-1.json')).data.entries[0].id, 'album');
});
