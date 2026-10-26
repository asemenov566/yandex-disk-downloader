import test from 'node:test';
import assert from 'node:assert/strict';
import { issueLink, diagnosticRows, sessionStatus } from '../photo_downloader_smnv/diagnostics-data.js';
import { createRunner } from '../photo_downloader_smnv/runner.js';
import { newJob, consumePage } from '../photo_downloader_smnv/core.js';
import { createDownloadPool } from '../photo_downloader_smnv/pool.js';

const resource = (count = 4) => ({ type: 'dir', name: 'Album', _embedded: { offset: 0, total: count,
  items: Array.from({ length: count }, (_, n) => ({ type: 'file', name: n + '.jpg', path: '/' + n + '.jpg', media_type: 'image', size: 3 })) } });
const waitUntil = async fn => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert(fn()); };

test('full diagnostics includes older errors, skips, failed directories and cleanup failures without exposing file metadata', async () => {
  const job = newJob('https://disk.yandex.ru/d/example'); consumePage(job, job.directories[0], resource(71));
  job.phase = 'done';
  job.files.forEach((file, n) => { file.state = n < 50 ? 'failed' : 'skipped'; file.reason = 'Reason ' + n; });
  job.files[70].state = 'done'; job.files[70].cleanupError = 'Preview cleanup failed';
  job.directories.push({ path: '/Folder #1', local: 'Folder #1', state: 'failed', reason: 'Folder error' });
  const runner = createRunner({ loadJob: async () => job, saveJob: async () => {} });
  const short = (await runner.command('status')).job;
  const full = (await runner.command('status', { allIssues: true })).job;
  assert.equal(short.issues.length, 30); assert.equal(full.issuesTotal, 72); assert.equal(full.issues.length, 72);
  assert.equal(full.issues.filter(x => x.state === 'skipped').length, 20);
  assert.equal(full.issues.at(-1).state, 'failed');
  assert.equal(full.issues[0].url, 'https://disk.yandex.ru/d/example/Folder%20%231');
  assert.equal(full.issues[1].name, '0.jpg'); assert.equal(full.issues[1].reason, 'Reason 0');
  const state = { jobs: [{ id: 'a', title: 'A', publicUrl: job.publicUrl, issues: full.issues }, { id: 'b', title: 'B', issues: [full.issues[0]] }] };
  assert.equal(diagnosticRows(state).length, 73); assert.equal(diagnosticRows(state, 'a').length, 72);
  assert.equal(diagnosticRows(state, 'deleted').length, 0);
  assert.equal('vk' in full.issues[0], false);
});

test('links encode Yandex paths and open VK photos in the keyed messenger viewer', () => {
  assert.equal(issueLink({ publicUrl: 'https://disk.yandex.ru/d/example' }, { path: '/Папка/a #?%.jpg' }),
    'https://disk.yandex.ru/d/example/' + encodeURIComponent('Папка') + '/a%20%23%3F%25.jpg');
  assert.equal(issueLink({ publicUrl: 'javascript:alert(1)' }, { path: '/a' }), '');
  assert.equal(issueLink({ publicUrl: 'https://disk.yandex.ru/d/example' }, { path: '/../a' }), '');
  const job = { publicUrl: 'https://vk.ru/im/convo/101' };
  const file = { kind: 'photo', path: '/photo123_456', vk: { cmid: 99, preview: { url: 'https://sun1.userapi.com/test.jpg' } } };
  assert.equal(issueLink(job, file), 'https://vk.ru/im?z=photo123_456');
  file.vk.accessKey = '0123456789abcdef01';
  assert.equal(issueLink(job, file), 'https://vk.ru/im?z=photo123_456/0123456789abcdef01');
  file.vk.original = { url: 'https://sun1.userapi.com/original.jpg?private=test' };
  assert(!issueLink(job, file).includes('userapi'));
  assert(!issueLink(job, file).includes('private'));
  file.vk.preview.url = 'https://evil.example/photo.jpg';
  const url = new URL(issueLink(job, file)); assert.equal(url.host, 'vk.ru'); assert.equal(url.searchParams.get('z'), 'photo123_456/0123456789abcdef01');
  file.vk.accessKey = 'key&redirect=https://evil.example';
  assert.equal(issueLink(job, file), 'https://vk.ru/im?z=photo123_456');
});

test('all concurrent transfers appear before a photo blob exists, progress is independent and pause removes them', async () => {
  const releases = new Map(), pool = createDownloadPool(5);
  const runner = createRunner({ loadJob: async () => null, saveJob: async () => {}, resource: async () => resource(),
    runFiles: pool.run, getPhoto: async (_job, file, _kind, signal, progress) => {
      progress((Number.parseInt(file.name) + 1) * 1048576);
      await new Promise((resolve, reject) => { releases.set(file.path, resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      return new Blob(['abc'], { type: 'image/jpeg' });
    }, saveLocal: async (savedPath, _source, options) => ({ savedPath, savedBytes: options.expectedSize, localFile: true }) });
  await runner.command('scan', { link: 'https://disk.yandex.ru/d/example' });
  await waitUntil(() => releases.size === 4);
  const snapshot = (await runner.command('status')).job.activeFiles;
  assert.equal(snapshot[0].url, 'https://disk.yandex.ru/d/example/0.jpg');
  assert.equal(snapshot.length, 4); assert.equal(new Set(snapshot.map(x => x.path)).size, 4);
  assert.equal(snapshot[0].status, '1.0 МБ'); assert.equal(snapshot[3].status, '4.0 МБ');
  releases.get('/0.jpg')();
  for (let i = 0; i < 200 && (await runner.command('status')).job.activeFiles.length === 4; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal((await runner.command('status')).job.activeFiles.length, 3);
  assert.equal(snapshot.length, 4);
  await runner.command('pause'); await runner.waitUntilIdle();
  assert.deepEqual((await runner.command('status')).job.activeFiles, []);
});

test('session status distinguishes connection, transfer, queue, completed errors and blocked work', () => {
  assert.equal(sessionStatus({ running: true, phase: 'done', current: 'Подключаемся к ВК…' }), 'Подключаемся к ВК…');
  assert.equal(sessionStatus({ queued: true }), 'ожидает запуска');
  assert.equal(sessionStatus({ phase: 'done', summary: { failed: 1 } }), 'завершено с ошибками');
  assert.equal(sessionStatus({ phase: 'downloading', notice: 'Нужно войти в ВК' }), 'Нужно войти в ВК');
  assert.equal(sessionStatus({ phase: 'downloading' }), 'пауза');
});
