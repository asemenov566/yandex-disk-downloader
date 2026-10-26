import { createQueue } from '../photo_downloader_smnv/queue.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticLog, errorInfo, logFileName, configureLogging, setLogging } from '../photo_downloader_smnv/logging.js';
import { createFileLog } from '../photo_downloader_smnv/file-log.js';

function disk() {
  const files = new Map(); let denied = false, failName = '';
  return { files, deny: value => { denied = value; }, fail: name => { failName = name; },
    getDirectory: async () => {
      if (denied) throw new Error('Permission denied');
      return { getFileHandle: async (name, options = {}) => {
        if (!files.has(name)) {
          if (!options.create) throw Object.assign(new Error('Missing'), { name: 'NotFoundError' });
          files.set(name, Buffer.alloc(0));
        }
        return {
          getFile: async () => ({ size: files.get(name).length, text: async () => files.get(name).toString() }),
          createWritable: async ({ keepExistingData } = {}) => {
            let content = keepExistingData ? Buffer.from(files.get(name)) : Buffer.alloc(0), position = 0;
            return {
              seek: async offset => { position = offset; },
              write: async value => { const data = Buffer.from(value); content = Buffer.concat([content.subarray(0, position), data]); },
              close: async () => { if (failName === name) throw new Error('Disk full'); files.set(name, content); },
              abort: async () => {}
            };
          }
        };
      } };
    }
  };
}
const schedule = () => () => {};

test('daily file survives logger restart, appends UTF-8 and excludes private request fields', async () => {
  const store = disk(), writer = createFileLog(store), now = () => new Date(2026, 9, 23, 12).getTime();
  const log = createDiagnosticLog({ ...writer, now, schedule });
  log.record('ignored'); assert.equal(store.files.size, 0);
  await log.setEnabled(true);
  log.record('vk.queued', { session: 'Тест', token: 'SECRET', body: 'PRIVATE', url: 'PRIVATE', stage: 'https://secret.test/path vk1.a.SECRET' });
  await log.flush();
  const name = 'log--23-10-2026.log', previous = store.files.get(name).toString();
  assert(previous.includes('Тест')); assert(!previous.includes('SECRET')); assert(!previous.includes('PRIVATE'));
  const restored = createDiagnosticLog({ ...writer, now, schedule });
  await restored.setEnabled(true); restored.record('after.restart'); await restored.flush();
  assert(store.files.get(name).toString().startsWith(previous));
  assert((await restored.export()).includes('after.restart'));
  await restored.setEnabled(false); const before = await restored.export();
  restored.record('ignored'); await restored.flush(); assert.equal(await restored.export(), before);
  assert.deepEqual(errorInfo(Object.assign(new Error('token=SECRET'), { status: 404 })), { status: 404, reason: 'failure' });
});

test('midnight rotates daily files; partial failure retries only uncommitted day', async () => {
  const store = disk(), writer = createFileLog(store);
  let time = new Date(2026, 9, 23, 23, 59).getTime();
  const log = createDiagnosticLog({ ...writer, now: () => time, schedule });
  await log.setEnabled(true); log.record('before.midnight');
  time = new Date(2026, 9, 24, 0, 1).getTime(); log.record('after.midnight');
  store.fail('log--24-10-2026.log'); await log.flush();
  assert.equal(log.status().logError, true); assert.equal(log.status().logPending, 1);
  store.fail(''); await log.flush(); assert.equal(log.status().logError, false);
  assert.equal(store.files.get('log--23-10-2026.log').toString().match(/before.midnight/g).length, 1);
  assert.equal(store.files.get('log--24-10-2026.log').toString().match(/after.midnight/g).length, 1);
  await log.clear();
  assert(store.files.get('log--23-10-2026.log').toString().includes('before.midnight'));
  assert(!(await log.export()).includes('after.midnight'));
});

test('folder denial retains bounded RAM events and retries without storing in browser', async () => {
  const store = disk(); store.deny(true);
  const log = createDiagnosticLog({ ...createFileLog(store), schedule, maxEntries: 4 });
  await log.setEnabled(true);
  for (let i = 0; i < 8; i++) log.record('progress', { count: i });
  await log.flush(); assert.equal(log.status().logPending, 4); assert(log.status().logDropped > 0);
  assert.equal(store.files.size, 0); await assert.rejects(log.clear());
  store.deny(false); await log.flush();
  assert.equal(log.status().logPending, 0); assert.equal(log.status().logError, false);
  assert.equal((await log.export()).trim().split('\n').length, 4);
});

test('events arriving during a disk write remain queued for the next write', async () => {
  let release, block = false; const persisted = [];
  const log = createDiagnosticLog({ schedule, append: async rows => {
    if (block) await new Promise(resolve => { release = resolve; });
    persisted.push(...rows);
  } });
  await log.setEnabled(true); block = true; log.record('first');
  const pending = log.flush(); await new Promise(resolve => setImmediate(resolve));
  log.record('second'); release(); await pending;
  block = false; await log.flush();
  assert.deepEqual(persisted.map(row => row.event), ['logging.enabled', 'first', 'second']);
  assert.equal(logFileName(new Date(2026, 0, 2)), 'log--02-01-2026.log');
});

test('frequent activity polls emit queue and file heartbeats at most once per 30 seconds', async () => {
  let time = 0, started = false, release;
  const records = [];
  configureLogging({ append: async rows => records.push(...rows), schedule });
  const queue = createQueue({
    now: () => time, loadEntries: async () => [], saveEntry: async () => {},
    loadSettings: async () => ({ logging: true }),
    resource: async () => ({ type: 'dir', name: 'Test', _embedded: { total: 1, offset: 0,
      items: [{ type: 'file', name: 'a.jpg', path: '/a.jpg', media_type: 'image', size: 3 }] } }),
    getPhoto: async () => { started = true; await new Promise(resolve => { release = resolve; }); return new Blob(['abc']); },
    saveLocal: async savedPath => ({ savedPath, savedBytes: 3, localFile: true })
  });
  try {
    await queue.command('scan', { link: 'https://disk.yandex.ru/d/test' });
    for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setImmediate(resolve));
    assert(started);
    for (time = 0; time <= 60000; time += 1000) queue.heartbeat();
    await setLogging(false);
    for (const event of ['queue.heartbeat', 'session.heartbeat', 'file.heartbeat']) {
      assert.equal(records.filter(row => row.event === event).length, 3, event);
    }
    queue.heartbeat();
    release(); await queue.waitUntilIdle();
  } finally { release?.(); await setLogging(false); configureLogging({ schedule }); }
});
