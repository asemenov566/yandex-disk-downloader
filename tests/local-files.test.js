import test from 'node:test';
import assert from 'node:assert/strict';
import { findLocalFiles, requireFolder, saveLocalFile, verifyLocalRecord } from '../photo_downloader_smnv/local-files.js';
import { createRunner } from '../photo_downloader_smnv/runner.js';

function folder(files, name = 'Downloads', granted = true) {
  const directory = prefix => ({ name, queryPermission: async () => granted ? 'granted' : 'denied',
    getDirectoryHandle: async part => directory(prefix + part + '/'),
    getFileHandle: async part => {
      const key = prefix + part;
      if (!files.has(key)) throw new DOMException('Missing', 'NotFoundError');
      return { getFile: async () => ({ size: files.get(key) }) };
    }
  });
  return directory('');
}

test('VK reuses a valid local original without remote byte size and rejects corrupt existing images', async () => {
  const originalDecoder = globalThis.createImageBitmap;
  const job = { provider: 'vk', folder: 'vk-messeger/Тестовый диалог' };
  const file = { local: 'photo123_1.jpg', kind: 'photo' };
  const root = folder(new Map([['vk-messeger/Тестовый диалог/photo123_1.jpg', 3]]));
  try {
    let decoded = false;
    globalThis.createImageBitmap = async f => { assert.equal(f.size, 3); decoded = true; return { close() {} }; };
    assert.equal((await findLocalFiles(root, job, file)).original.savedBytes, 3); assert(decoded);
    globalThis.createImageBitmap = async () => { throw new Error('corrupt'); };
    await assert.rejects(findLocalFiles(root, job, file), /не читается/);
  } finally { globalThis.createImageBitmap = originalDecoder; }
});

function harness(entries, originalAvailable) {
  const files = new Map(entries), root = folder(files);
  const attempts = [], downloads = [], receipts = new Map();
  const runner = createRunner({ loadJob: async () => null, saveJob: async () => {},
    findLocal: (job, file) => findLocalFiles(root, job, file),
    resource: async () => ({ type: 'dir', name: 'Album', _embedded: { offset: 0, total: 1, items: [
      { type: 'file', name: 'photo.jpg', path: '/photo.jpg', size: 3, media_type: 'image' }
    ] } }),
    getPhoto: async (_job, _file, kind) => {
      attempts.push(kind);
      if (kind === 'original' && !originalAvailable) throw new Error('Unavailable');
      return new Blob(['abc'], { type: 'image/jpeg' });
    },
    downloads: {
      download: async args => {
        downloads.push(args); files.set(args.filename, 3);
        receipts.set(downloads.length, { state: 'complete', exists: true, filename: args.filename, fileSize: 3 });
        return downloads.length;
      },
      search: async ({ id }) => receipts.has(id) ? [receipts.get(id)] : [],
      cancel: async () => {}
    }
    // Intentionally no stored jobs or history: the filesystem is the evidence.
  });
  return { runner, attempts, downloads, files };
}

for (const available of [false, true]) test(`existing original prevents ALL requests with empty history, original available=${available}`, async () => {
  const h = harness([['yandex-disk/Album/photo.jpg', 3]], available);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test', mode: 'preview' });
  await h.runner.waitUntilIdle();
  assert.deepEqual(h.attempts, []); assert.equal(h.downloads.length, 0);
  assert.equal((await h.runner.command('status')).job.summary.originals, 1);
});

test('existing preview is reused without another copy when original is unavailable', async () => {
  const h = harness([['yandex-disk/Album/photo.preview.jpg', 2]], false);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert.deepEqual(h.attempts, ['original']); assert.equal(h.downloads.length, 0);
  assert.equal((await h.runner.command('status')).job.summary.previews, 1);
  await h.runner.command('retry', { includePreviews: true }); await h.runner.waitUntilIdle();
  assert.deepEqual(h.attempts, ['original', 'original']); assert.equal(h.downloads.length, 0);
});

test('existing preview upgrades to original once; fresh scan still works without receipts', async () => {
  const h = harness([['yandex-disk/Album/photo.preview.jpg', 2]], true);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert.equal(h.downloads.length, 1); assert.deepEqual(h.attempts, ['original']);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert.equal(h.downloads.length, 1);
});

test('mismatched original is reported instead of silently creating a numbered duplicate', async () => {
  const h = harness([['yandex-disk/Album/photo.jpg', 1]], true);
  await h.runner.command('scan', { link: 'https://disk.yandex.ru/d/test' }); await h.runner.waitUntilIdle();
  assert.equal(h.downloads.length, 0); assert.deepEqual(h.attempts, []);
  const state = await h.runner.command('status');
  assert.equal(state.job.summary.failed, 1); assert.match(state.job.issues[0].reason, /размер/);
});

test('missing permissions stop verification; yandex-disk is always inside selected parent', async () => {
  await assert.rejects(requireFolder(null), error => error.localAccess === true);
  await assert.rejects(requireFolder(folder(new Map(), 'Downloads', false)), error => error.localAccess === true);
  const result = await findLocalFiles(folder(new Map([['yandex-disk/Album/photo.jpg', 3]]), 'yandex-disk'),
    { folder: 'yandex-disk/Album' }, { local: 'photo.jpg', kind: 'photo', size: 3 });
  assert.equal(result.original.savedBytes, 3);
});

function writableFolder() {
  const files = new Map(), directories = new Set();
  const directory = prefix => ({ name: 'Chosen', queryPermission: async () => 'granted',
    getDirectoryHandle: async (part, options) => {
      const path = prefix + part + '/';
      if (options?.create) directories.add(path);
      if (!directories.has(path)) throw new DOMException('Missing', 'NotFoundError');
      return directory(path);
    },
    removeEntry: async part => files.delete(prefix + part),
    getFileHandle: async (part, options) => {
      const path = prefix + part;
      if (!files.has(path)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        files.set(path, new Blob([]));
      }
      return { getFile: async () => files.get(path), createWritable: async () => {
        const chunks = [];
        return { write: async chunk => chunks.push(chunk), abort: async () => {}, close: async () => files.set(path, new Blob(chunks)) };
      } };
    }
  });
  return { root: directory(''), files, directories };
}

test('writes to selected parent/yandex-disk, reuses directories, never overwrites existing file', async () => {
  const { root, files, directories } = writableFolder();
  const path = 'yandex-disk/Album/photo.jpg', source = new Blob(['abc']);
  const record = await saveLocalFile(root, path, source, { expectedSize: 3 });
  assert.equal(await files.get(path).text(), 'abc');
  assert(directories.has('yandex-disk/'));
  await assert.rejects(saveLocalFile(root, path, new Blob(['xyz'])), /уже появился/);
  assert.equal(await files.get(path).text(), 'abc');
  assert.equal((await verifyLocalRecord(root, record)).savedBytes, 3);
  assert.equal(await verifyLocalRecord(root, { ...record, localFile: false }), null);
  assert.equal(await verifyLocalRecord(writableFolder().root, record), null);
});

test('streams video without a full Blob, checks size and removes only its failed placeholder', async () => {
  const { root, files } = writableFolder();
  const path = 'yandex-disk/Album/video.mov';
  let credentials, count = 0;
  const fetcher = async (_url, options) => {
    credentials = options.credentials;
    return new Response(new ReadableStream({ pull(c) { if (count++ < 3) c.enqueue(new Uint8Array([1, 2])); else c.close(); } }));
  };
  await saveLocalFile(root, path, 'https://downloader.disk.yandex.ru/test', { direct: true, expectedSize: 6, fetcher });
  assert.equal(files.get(path).size, 6); assert.equal(credentials, 'omit');
  await assert.rejects(saveLocalFile(root, 'yandex-disk/Album/bad.mov', new Blob(['a']), { expectedSize: 3 }), /Размер/);
  assert(!files.has('yandex-disk/Album/bad.mov'));
  assert.equal(files.get(path).size, 6);
});

test('VK video streams small chunks, checks MP4 signature and Content-Length, and reuses the saved file', async () => {
  const { root, files } = writableFolder();
  const bytes = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);
  const path = 'vk-messeger/Test/video123_1.mp4';
  let offset = 0;
  const fetcher = async () => new Response(new ReadableStream({ pull(c) {
    if (offset < bytes.length) { c.enqueue(bytes.slice(offset, offset + 2)); offset += 2; } else c.close();
  } }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '12' } });
  await saveLocalFile(root, path, 'https://vkvd360.okcdn.ru/?video=1', { direct: true, fetcher });
  assert.equal(files.get(path).size, 12);
  const local = await findLocalFiles(root, { provider: 'vk', folder: 'vk-messeger/Test' }, { kind: 'video', local: 'video123_1.mp4' });
  assert.equal(local.original.savedBytes, 12);
  for (const [body, type, length] of [['not video!!!', 'video/mp4', '12'], [bytes, 'video/mp4', '20'], ['<html>error', 'text/html', '10']]) {
    const bad = 'vk-messeger/Test/bad.mp4';
    await assert.rejects(saveLocalFile(root, bad, 'https://vkvd360.okcdn.ru/?video=2', { direct: true,
      fetcher: async () => new Response(body, { headers: { 'Content-Type': type, 'Content-Length': length } }) }));
    assert(!files.has(bad));
  }
});

test('abort and no-data timeout leave no partial file and allow a later retry', async () => {
  for (const abort of [true, false]) {
    const { root, files } = writableFolder();
    const path = 'yandex-disk/Album/video.mov', controller = new AbortController();
    const fetcher = async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array([1]));
    } }));
    const saving = saveLocalFile(root, path, 'https://downloader.disk.yandex.ru/test', {
      direct: true, expectedSize: 2, fetcher, signal: controller.signal, timeout: 15,
      onProgress: () => { if (abort) controller.abort(); }
    });
    await assert.rejects(saving); assert(!files.has(path));
    await saveLocalFile(root, path, new Blob(['ok']), { expectedSize: 2 });
    assert.equal(await files.get(path).text(), 'ok');
  }
});

test('file appearing while waiting for the server is preserved', async () => {
  const { root, files } = writableFolder();
  const path = 'yandex-disk/Album/video.mov';
  await assert.rejects(saveLocalFile(root, path, 'https://downloader.disk.yandex.ru/test', {
    direct: true, expectedSize: 3, fetcher: async () => {
      files.set(path, new Blob(['keep'])); return new Response('new');
    }
  }), /уже появился/);
  assert.equal(await files.get(path).text(), 'keep');
});

test('optional content deduplication can reuse a disk file with initially empty history', async () => {
  const { root, files, directories } = writableFolder(), history = new Map();
  directories.add('yandex-disk/'); directories.add('yandex-disk/Album/');
  files.set('yandex-disk/Album/a.jpg', new Blob(['abc']));
  let requests = 0;
  const runner = createRunner({ loadJob: async () => null, saveJob: async () => {},
    loadHistory: async key => history.get(key), saveHistory: async (key, value) => history.set(key, structuredClone(value)),
    findLocal: (job, file) => findLocalFiles(root, job, file), verifyLocal: record => verifyLocalRecord(root, record),
    saveLocal: (path, source, options) => saveLocalFile(root, path, source, options), downloads: {},
    resource: async () => ({ type: 'dir', name: 'Album', _embedded: { offset: 0, total: 2,
      items: ['a.jpg', 'b.jpg'].map(name => ({ type: 'file', name, path: '/' + name, size: 3, media_type: 'image', sha256: 'a'.repeat(64) })) } }),
    getPhoto: async () => { requests++; return new Blob(['abc'], { type: 'image/jpeg' }); }
  });
  await runner.command('scan', { link: 'https://disk.yandex.ru/d/test', deduplicate: true }); await runner.waitUntilIdle();
  assert.equal(requests, 0); assert.equal(files.size, 1);
  assert.equal((await runner.command('status')).job.summary.reused, 2);
  await runner.command('scan', { link: 'https://disk.yandex.ru/d/test', deduplicate: false }); await runner.waitUntilIdle();
  assert.equal(requests, 1); assert.equal(files.size, 2);
});
