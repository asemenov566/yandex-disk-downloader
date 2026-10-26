import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceDates, vkSourceDates, ydSourceDates, DATES_FILE, DATE_RESULTS_FILE } from '../photo_downloader_smnv/source-dates.js';
import { createDateManager, dateIdentity } from '../photo_downloader_smnv/date-manager.js';
import { findLocalFiles } from '../photo_downloader_smnv/local-files.js';
import { createRunner } from '../photo_downloader_smnv/runner.js';
import { photoDatePlan, parsePhotoDate } from '../photo_downloader_smnv/photo-dates.js';

function fixture() {
  const files = new Map(), directories = new Map();
  const directory = prefix => {
    if (directories.has(prefix)) return directories.get(prefix);
    const value = { queryPermission: async () => 'granted', getDirectoryHandle: async name => directory(prefix + name + '/'),
      getFileHandle: async (name, options = {}) => {
        const key = prefix + name;
        if (!files.has(key)) { if (!options.create) throw new DOMException('Missing', 'NotFoundError'); files.set(key, ''); }
        return { getFile: async () => {
          const stored = files.get(key);
          return typeof stored === 'string' ? { text: async () => stored } : { ...stored };
        }, createWritable: async () => {
          let pending;
          return { write: async text => { pending = text; }, close: async () => files.set(key, pending), abort: async () => {} };
        }};
      }};
    directories.set(prefix, value); return value;
  };
  return { files, root: directory(''), dir: directory('') };
}
const job = { provider: 'vk', publicUrl: 'https://vk.ru/im/convo/1', folder: 'vk-messeger/Test' };
const file = { path: '/photo1_2', local: 'photo1_2.jpg', kind: 'photo' };
const item = (uploaded, sent) => ({ date: sent, attachment: { type: 'photo', photo: { id: 2, owner_id: 1, date: uploaded } } });

test('per-folder dates mirror global entries, include local filenames, and isolate nested folders', async () => {
  const f = fixture(), store = createSourceDates({ getDirectory: async () => f.dir, getRoot: async () => f.root });
  const j = { ...job, files: [file, { ...file, path: '/photo1_3', local: 'nested/photo1_3.jpg' }] };
  await store.capture(j, [[file.path, { date: '2020-01-01T00:00:00Z', source: 'vk.photo.date' }],
    ['/photo1_3', { date: '2021-01-01T00:00:00Z', source: 'vk.item.date' }]]);
  const global = JSON.parse(f.files.get(DATES_FILE));
  const first = JSON.parse(f.files.get('vk-messeger/Test/' + DATES_FILE));
  const nested = JSON.parse(f.files.get('vk-messeger/Test/nested/' + DATES_FILE));
  assert.equal(Object.keys(global.dates).length, 2); assert.equal(Object.keys(first.dates).length, 1); assert.equal(Object.keys(nested.dates).length, 1);
  assert.equal(Object.values(first.dates)[0].local, 'photo1_2.jpg');
  await store.mirror(j, [{ ...file, savedPath: 'vk-messeger/Test/photo1_2.preview.jpg' }]);
  assert.deepEqual(Object.values(JSON.parse(f.files.get('vk-messeger/Test/' + DATES_FILE)).dates)[0].saved, ['photo1_2.preview.jpg']);
  f.files.set('vk-messeger/Test/' + DATES_FILE, '{broken');
  await assert.rejects(store.mirror(j, [file])); assert.equal(f.files.get('vk-messeger/Test/' + DATES_FILE), '{broken');
});

test('date policy preserves existing EXIF and XMP, rejects invalid dates, fills only missing tags', () => {
  const base = { 'File:FileType': 'JPEG' }, fallback = { date: '2020-01-01T00:00:00Z', source: 'vk.photo.date' };
  assert.equal(parsePhotoDate('2020:02:31 12:00:00'), null);
  assert.equal(parsePhotoDate('0000:00:00 00:00:00'), null);
  const plan = photoDatePlan({ ...base, 'ExifIFD:DateTimeOriginal': '2010:02:03 12:34:56', 'ExifIFD:OffsetTimeOriginal': '+04:00' }, fallback);
  assert.equal(plan.tags['EXIF:CreateDate'], '2010:02:03 12:34:56'); assert.equal(plan.tags['EXIF:OffsetTimeDigitized'], '+04:00');
  assert.equal(plan.tags['EXIF:DateTimeOriginal'], undefined); assert.equal(plan.fallback, false);
  assert.equal(photoDatePlan({ ...base, 'XMP-photoshop:DateCreated': '2015:03:02 10:00:00+03:00' }, fallback).date, '2015:03:02 10:00:00');
  assert.equal(photoDatePlan(base).status, 'needs-date');
  assert.equal(photoDatePlan(base, fallback).fallback, true);
  assert.equal(photoDatePlan({ ...base, 'ExifIFD:DateTimeOriginal': '2010:02:03 12:34:56', 'ExifIFD:CreateDate': '2011:02:03 12:34:56' }, fallback).status, 'unchanged');
});

test('browser dates resolve a missing source, prepare size receipt, and never modify reused photos or videos', async () => {
  const f = fixture(), input = new Blob(['source']), output = new Blob(['metadata-added']); let queries = 0, processing = 0;
  const manager = createDateManager({ getDirectory: async () => f.dir, getRoot: async () => f.root,
    process: async (blob, date) => { processing++; return date ? { status: 'updated', blob: output, date: date.date, source: date.source, fallback: true } : { status: 'needs-date', blob }; },
    resolveDate: async j => { queries++; await manager.capture(j, vkSourceDates([item(1600000000)])); },
    readLocal: async () => ({ size: output.size, lastModified: 1234 }) });
  const j = { ...job, files: [file] }, path = job.folder + '/' + file.local;
  assert.equal(await manager.prepare(j, file, input, 'original', path, signal()), output);
  assert.equal(queries, 1); assert.equal(processing, 2);
  assert.equal(JSON.parse(f.files.get(DATE_RESULTS_FILE)).files[path].state, 'prepared');
  await manager.afterSave(j, Object.assign(file, { savedPath: path, localFile: true, savedBytes: output.size }));
  assert.equal(JSON.parse(f.files.get(DATE_RESULTS_FILE)).files[path].state, 'applied');
  await manager.afterSave(j, { ...file, reused: true });
  assert.equal(await manager.prepare(j, { ...file, kind: 'video' }, input, 'original', path, signal()), input);
  assert.equal(processing, 2);
});

test('metadata failure preserves incoming blob; abort does not write a success receipt', async () => {
  const f = fixture(), blob = new Blob(['source']), controller = new AbortController();
  const manager = createDateManager({ getDirectory: async () => f.dir,
    process: async () => { throw new Error('Bad metadata'); } });
  assert.equal(await manager.prepare(job, file, blob, 'preview', 'test', signal()), blob);
  assert.equal(manager.snapshot().errors, 1);
  controller.abort(); await assert.rejects(manager.prepare(job, file, blob, 'original', 'test', controller.signal));
  assert(!f.files.has(DATE_RESULTS_FILE));
});

function signal() { return new AbortController().signal; }

test('VK upload date takes precedence; missing/invalid upload falls back to message date', () => {
  assert.equal(vkSourceDates([item(1600000000, 1700000000)])[0][1].source, 'vk.photo.date');
  assert.equal(vkSourceDates([item(0, 1700000000)])[0][1].source, 'vk.item.date');
  assert.equal(vkSourceDates([item(undefined, 1700000000)])[0][1].date, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(vkSourceDates([item('bad', undefined)]), []);
  assert.equal(ydSourceDates({ type: 'file', path: '/x', created: '2020-04-05T12:00:00+03:00', modified: '2025-01-01' })[0][1].date, '2020-04-05T09:00:00.000Z');
  assert.deepEqual(ydSourceDates({ type: 'file', path: '/x', modified: '2025-01-01' }), []);
});

test('separate date JSON survives reload, strips links/tokens, never downgrades upload to sent', async () => {
  const f = fixture();
  const make = () => createSourceDates({ getDirectory: async () => f.dir, uuid: () => 'root-1' });
  const dates = make();
  await Promise.all([dates.capture(job, vkSourceDates([item(1600000000, 1700000000)])), dates.capture(job, vkSourceDates([item(null, 1700000000)]))]);
  assert.equal((await make().get(job, file.path)).source, 'vk.photo.date');
  assert.equal(await make().rootId(), 'root-1');
  assert.deepEqual([...f.files.keys()], [DATES_FILE]);
  assert(!f.files.get(DATES_FILE).includes('access_token'));
});

test('corrupt separate JSON is reported without overwriting it', async () => {
  const f = fixture(); f.files.set(DATES_FILE, '{bad');
  const dates = createSourceDates({ getDirectory: async () => f.dir });
  await assert.rejects(dates.rootId());
  assert.equal(f.files.get(DATES_FILE), '{bad');
});

test('metadata-modified Yandex original is reused on fresh download with empty main history', async () => {
  const f = fixture(); let downloads = 0;
  const yd = { publicUrl: 'https://disk.yandex.ru/d/test', folder: 'yandex-disk/Album' };
  const ydFile = { path: '/photo.jpg', local: 'photo.jpg', kind: 'photo', size: 3, sha256: 'remote-hash' };
  const path = 'yandex-disk/Album/photo.jpg';
  f.files.set(path, { size: 100, lastModified: 123456 });
  f.files.set(DATE_RESULTS_FILE, JSON.stringify({ schema: 1, files: { [path]: {
    state: 'applied', sourceKey: await dateIdentity(yd, ydFile), sourceBytes: 3, sourceSha256: 'remote-hash', outputBytes: 100, modifiedMs: 123456
  } } }));
  const manager = createDateManager({ getDirectory: async () => f.dir });
  const runner = createRunner({ loadJob: async () => null, saveJob: async () => {},
    findLocal: (j, file) => findLocalFiles(f.root, j, file, manager.receipt),
    resource: async () => ({ type: 'dir', name: 'Album', _embedded: { offset: 0, total: 1, items: [
      { type: 'file', name: 'photo.jpg', path: '/photo.jpg', size: 3, sha256: 'remote-hash', media_type: 'image' }
    ] } }), getPhoto: async () => { downloads++; throw Error('Must reuse existing file'); } });
  await runner.command('scan', { link: yd.publicUrl }); await runner.waitUntilIdle();
  assert.equal((await runner.command('status')).job.summary.originals, 1); assert.equal(downloads, 0);
  f.files.set(path, { size: 101, lastModified: 123456 });
  await assert.rejects(findLocalFiles(f.root, yd, ydFile, manager.receipt), /размер/);
});
