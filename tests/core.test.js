import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, newJob, consumePage, classify, safeName, outputPath, mediaUrl, summary, report } from '../photo_downloader_smnv/core.js';

const image = (name, path = '/' + name) => ({ name, path, type: 'file', media_type: 'image', size: 123, mime_type: 'image/jpeg' });
test('public links include nested paths and reject private/foreign/path traversal links', () => {
  assert.deepEqual(parseLink('https://disk.yandex.ru/d/abc/Photo%20folder'), { publicUrl: 'https://disk.yandex.ru/d/abc', path: '/Photo folder' });
  assert.equal(parseLink('https://yadi.sk/i/abc').path, '/');
  for (const value of ['https://evil.example/d/abc', 'https://disk.yandex.ru/client/disk', 'http://disk.yandex.ru/d/abc']) assert.throws(() => parseLink(value));
});

test('scans all pages with server-shortened page size and nested folder, without duplicates', () => {
  const job = newJob('https://disk.yandex.ru/d/test');
  const root = job.directories[0];
  const files = Array.from({ length: 503 }, (_, n) => image(`photo-${n}.JPG`));
  const all = [...files, { name: 'nested', path: '/nested', type: 'dir' }];
  for (let offset = 0; offset < all.length; offset += 73) {
    assert.equal(root.offset, offset);
    consumePage(job, root, { name: 'Альбом', type: 'dir', _embedded: { total: all.length, offset, items: all.slice(offset, offset + 73) } });
  }
  assert.equal(root.state, 'done');
  assert.equal(job.phase, 'scanning');
  const nested = job.directories.find(d => d.path === '/nested');
  consumePage(job, nested, { type: 'dir', _embedded: { total: 2, offset: 0, items: [image('photo.JPG', '/nested/photo.JPG'), { ...image('movie.MOV','/nested/movie.MOV'), media_type: 'video' }] } });
  assert.equal(job.phase, 'ready');
  assert.equal(job.files.length, 505);
  assert.equal(summary(job).photos, 504);
  assert.equal(summary(job).skipped, 0);
  assert.equal(job.files.find(f => f.name === 'movie.MOV').state, 'pending');
  assert.equal(job.files.find(f => f.path === '/nested/photo.JPG').local, 'nested/photo.JPG');
  assert.equal(job.folder, 'yandex-disk/Альбом');
  assert.equal(job.pages, 8);
});

test('restart from saved page offset and repeated resources do not duplicate queue', () => {
  let job = newJob('https://disk.yandex.ru/d/test');
  consumePage(job, job.directories[0], { name: 'Album', type: 'dir', _embedded: { total: 3, items: [image('a.JPG'), image('b.JPG')] } });
  job = structuredClone(job);
  consumePage(job, job.directories[0], { type: 'dir', _embedded: { total: 3, offset: 2, items: [image('b.JPG')] } });
  assert.equal(job.files.length, 2);
  assert.equal(job.phase, 'ready');
});

test('missing or inconsistent pages fail instead of reporting a complete album', () => {
  for (const embedded of [undefined, { total: 5, items: [] }, { total: 1, offset: 99, items: [image('a.JPG')] }]) {
    const job = newJob('https://disk.yandex.ru/d/test');
    assert.throws(() => consumePage(job, job.directories[0], { type: 'dir', _embedded: embedded }));
    assert.equal(job.phase, 'scanning');
  }
});

test('video and non-photo are classified; only zero-byte items are skipped', () => {
  assert.equal(classify({ name: 'FILE.MP4', type: 'file', media_type: 'image' }), 'video');
  assert.equal(classify({ name: 'file.pdf', type: 'file' }), 'other');
  const job = newJob('https://disk.yandex.ru/i/test');
  consumePage(job, job.directories[0], { ...image('empty.JPG'), size: 0 });
  assert.equal(job.files[0].state, 'skipped');
  assert.equal(job.phase, 'ready');
});

test('Windows filenames and case collisions cannot escape destination or overwrite each other', () => {
  assert.equal(safeName('Сочи 2022 '), 'Сочи 2022');
  assert.equal(safeName('Сочи 2022.'), 'Сочи 2022');
  for (const name of ['..', '../secret', 'C:\\photo', 'NUL', 'con.jpg', 'a:b?.jpg', 'trailing.']) {
    const result = safeName(name);
    assert(!/[<>:"/\\|?*]/.test(result));
    assert(!/[. ]$/.test(result));
    assert(!/^(con|nul)(\.|$)/i.test(result));
  }
  const job = newJob('https://disk.yandex.ru/d/test');
  consumePage(job, job.directories[0], { name: 'album', type: 'dir', _embedded: { total: 2, items: [image('IMG.JPG'),image('img.jpg')] } });
  assert.notEqual(job.files[0].local.toLowerCase(), job.files[1].local.toLowerCase());
});

test('preview filenames are explicit and never pretend to be RAW originals', () => {
  assert.equal(outputPath({ folder: 'yandex-disk/Album' }, { local: 'Sub/one.NEF' }, 'preview','image/jpeg'), 'yandex-disk/Album/Sub/one.preview.jpg');
  assert.equal(outputPath({ folder: 'yandex-disk/Album' }, { local: 'one.JPG' }, 'original','image/jpeg'), 'yandex-disk/Album/one.JPG');
});

test('only known HTTPS media hosts are accepted', () => {
  assert(mediaUrl('https://downloader.disk.yandex.ru/preview/a'));
  for (const url of ['file:///C:/x', 'http://downloader.disk.yandex.ru/a', 'https://downloader.disk.yandex.ru.evil.example/a']) assert.throws(() => mediaUrl(url));
});

test('report includes unread directories and labels reduced copies', () => {
  const job = newJob('https://disk.yandex.ru/d/test');
  job.directories[0].state = 'failed'; job.directories[0].reason = 'HTTP 500';
  job.files.push({ path: '/x.JPG', state: 'done', savedKind: 'preview', savedPath: 'x.preview.jpg' });
  const csv = report(job);
  assert(csv.includes('failed_directory'));
  assert(csv.includes('preview'));
});
