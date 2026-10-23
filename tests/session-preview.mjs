// Isolated UI fixtures: no VK/Yandex navigation or remote downloads.
import { createRequire } from 'node:module';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('test-output/preview-' + Date.now());
const extension = path.join(output, 'extension'); await mkdir(output, { recursive: true });
await cp(path.resolve('extension'), extension, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(output, 'profile'), {
  executablePath: process.env.CHROMIUM_PATH, headless: true, viewport: { width: 780, height: 780 },
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
});
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = 'chrome-extension://' + new URL(worker.url()).host;
  await context.addInitScript(() => {
    if (!globalThis.chrome?.runtime?.id) return;
    const summary = { total: 100, done: 80, originals: 75, previews: 5, skipped: 0, failed: 20,
      directoriesFailed: 0, newFiles: 20, reused: 0, pending: 0 };
    const timing = { elapsedMs: 123000, remainingMs: 45000, intervals: [[0, 123000]], partial: false };
    const issues = Array.from({ length: 80 }, (_, n) => ({ name: 'file ' + n + '.jpg', path: 'Album / file ' + n + '.jpg',
      reason: n === 0 ? '<img src=x onerror=alert(1)>' : 'Проверочная причина ' + n, state: n < 55 ? 'failed' : 'skipped',
      url: 'https://disk.yandex.ru/d/example/file%20' + n + '.jpg' }));
    const jobs = Array.from({ length: 23 }, (_, n) => ({ id: 'job-' + n, title: n === 1 ? 'Очень длинное название сессии' : 'Сессия номер ' + n,
      publicUrl: 'https://disk.yandex.ru/d/fixture' + n, path: '/', folder: 'Album', provider: 'yandex', mode: 'auto',
      summary: { ...summary }, done: 80, total: 100, issues: n < 2 ? issues : [], issuesTotal: n < 2 ? 80 : 0,
      phase: n < 2 ? 'downloading' : 'done', running: n === 1, queued: false, completed: n > 1, resumable: n === 0,
      current: n === 1 ? 'Подключаемся к открытому диалогу…' : '', pages: 3, timing: n > 1 ? { ...timing, remainingMs: 0 } : timing, pendingDirectories: 0,
      activeFiles: n === 1 ? Array.from({ length: 5 }, (_, i) => ({ path: '/' + i + '.jpg', name: i + '.jpg', status: i + '.0 МБ', kind: 'photo' })) : [] }));
    window.fixture = { id: 'job-1', job: jobs[1], jobs, running: true, current: jobs[1].current, notice: '',
      activeDownloads: 5, downloadLimit: 5, vkDownloadLimit: 5, timeoutSeconds: 25, completionRepeats: 0 };
    window.calls = []; window.opened = [];
    chrome.tabs.query = async options => options?.url ? [{ id: 31 }, { id: 32 }] : [];
    window.reloaded = []; chrome.tabs.reload = async id => { window.reloaded.push(id); };
    chrome.windows.create = async options => { window.opened.push(options); return { id: 99 }; };
    chrome.runtime.sendMessage = async request => {
      window.calls.push(structuredClone(request));
      const args = request.args || {}, job = jobs.find(j => j.id === args.id) || jobs[1];
      if (request.action === 'pause' || request.action === 'start' || request.action === 'retry') {
        job.running = request.action !== 'pause'; job.completed = false; job.resumable = !job.running;
        job.phase = 'downloading'; job.current = job.running ? 'Получаем оригинал' : '';
      }
      if (request.action === 'settings') Object.assign(window.fixture, args);
      return { ok: true, value: structuredClone({ ...window.fixture, id: job.id, job, running: job.running, current: job.current }) };
    };
    window.showDirectoryPicker = async () => navigator.storage.getDirectory();
    if (window.FileSystemHandle) {
      FileSystemHandle.prototype.queryPermission = async () => 'granted';
      FileSystemHandle.prototype.requestPermission = async () => 'granted';
    }
  });
  const page = await context.newPage(); await page.goto(base + '/app.html?view=tab');
  await page.waitForFunction(() => document.querySelectorAll('.session-row').length === 23);
  assert.equal(await page.locator('#jobs').count(), 0); assert(await page.locator('#download-card').isHidden());
  assert(await page.locator('#sessions-retry-previews').isChecked()); assert.equal(await page.locator('#retry-all-previews').count(), 0);
  assert.deepEqual(await page.locator('.session-row').evaluateAll(rows => rows.slice(0,3).map(row => row.dataset.id)), ['job-0', 'job-1', 'job-2']);
  const active = page.locator('.session-row[data-id="job-1"]');
  assert.match(await active.locator('.session-name').textContent(), /Очень длин…/);
  assert.equal(await active.locator('.session-controls button').count(), 1);
  assert.equal(await active.locator('.session-resume').getAttribute('aria-label'), 'Пауза');
  assert.equal(await active.locator('.session-name').getAttribute('title'), '[YD] Очень длинное название сессии');
  assert.equal(await active.locator('progress').evaluate(el => el.value), 80);
  assert.equal(await active.locator('.session-new').textContent(), '20');
  assert.equal(await active.locator('.session-errors').textContent(), '20');
  assert.match(await active.locator('.session-timing').textContent(), /Осталось файлов: 20 · из них ошибок: 20/);
  await page.locator('#sessions-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'sessions-780.png') });
  await page.evaluate(() => { window.oldRow = document.querySelector('.session-row[data-id="job-1"]'); window.fixture.jobs[1].current = 'Новый статус передачи'; });
  await page.waitForFunction(() => document.querySelector('.session-row[data-id="job-1"] .session-status').textContent === 'Новый статус передачи');
  assert(await page.evaluate(() => window.oldRow === document.querySelector('.session-row[data-id="job-1"]')));

  await page.evaluate(() => {
    window.fixture.jobs.splice(4);
    const jobs = window.fixture.jobs;
    jobs[0].title = 'Альбом на паузе';
    jobs[1].title = 'Диалог ВК'; jobs[1].publicUrl = 'https://vk.ru/im/convo/1';
    jobs[1].current = 'photo123_456.jpg · получаем оригинал'; jobs[1].summary.pending = 15; jobs[1].summary.failed = 5;
    jobs[2].title = 'Архив с ошибками';
    jobs[3].title = 'Сохранённый альбом'; jobs[3].summary = { ...jobs[3].summary, done: 100, originals: 95, previews: 5, failed: 0 }; jobs[3].done = 100;
  });
  await page.waitForFunction(() => document.querySelector('.session-row[data-id="job-1"] .session-status').textContent.includes('photo123'));
  await page.locator('#sessions-card').screenshot({ path: path.join(output, 'sessions-preview.png') });
  console.log(JSON.stringify({ output }));
} finally { await context.close(); }
