// Isolated UI fixtures: no VK/Yandex navigation or remote downloads.
import { createRequire } from 'node:module';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('test-output/diagnostics-ui-' + Date.now());
const extension = path.join(output, 'photo_downloader_smnv'); await mkdir(output, { recursive: true });
await cp(path.resolve('photo_downloader_smnv'), extension, { recursive: true });
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
  await page.locator('#overall-card > summary').click();
  assert.equal(await page.locator('#overall-card').evaluate(el => el.open), false);
  assert(await page.locator('#overall-total').isHidden());
  assert(await page.locator('#overall-percent').isVisible());
  await page.waitForTimeout(1600);
  assert.equal(await page.locator('#overall-card').evaluate(el => el.open), false);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.session-row').length === 23);
  assert.equal(await page.locator('#overall-card').evaluate(el => el.open), false);
  await page.locator('#overall-card > summary').focus();
  await page.keyboard.press('Enter');
  assert(await page.locator('#overall-total').isVisible());
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
  const pagesBefore = context.pages().length;
  await active.locator('.session-open').click();
  const individual = page;
  await page.waitForFunction(() => document.getElementById('session-dialog').open);
  assert.equal(context.pages().length, pagesBefore); assert.equal(await page.evaluate(() => window.opened.length), 0);
  const sessionBox = await page.locator('#session-dialog').boundingBox();
  assert.equal(Math.round(sessionBox.width), 750);
  const closeBox = await page.getByRole('button', { name: 'Закрыть сессию', exact: true }).boundingBox();
  assert(sessionBox.x + sessionBox.width - closeBox.x - closeBox.width < 25);
  assert.equal(await page.locator('#session-dialog #source-card').count(), 0);
  assert.equal(await page.locator('#session-dialog input[type="url"]').count(), 0);
  await individual.waitForFunction(() => document.getElementById('active-files-count').textContent === '5');
  assert(await individual.locator('#download-card').isVisible());
  assert(await individual.locator('#retry-previews').isChecked()); assert.equal(await individual.locator('#active-files').evaluate(el => el.open), false);
  await individual.locator('#active-files summary').click(); assert.equal(await individual.locator('#active-files-list li').count(), 5);
  await individual.evaluate(() => { window.fixture.jobs[1].activeFiles[4].status = '17.0 МБ'; });
  await individual.waitForFunction(() => document.getElementById('active-files-list').textContent.includes('17.0 МБ'));
  assert.equal(await individual.locator('#active-files').evaluate(el => el.open), true);
  await individual.screenshot({ path: path.join(output, 'session-dialog.png') });
  await individual.locator('#active-files summary').click();
  assert.equal(await individual.locator('#active-files').evaluate(el => el.open), false);
  await individual.locator('#active-files-open').click();
  assert.equal(Math.round((await page.locator('#transfers-dialog').boundingBox()).width), 700);
  await page.evaluate(() => { window.fixture.jobs[1].activeFiles = Array.from({ length: 50 }, (_, n) => ({ path: '/' + n, name: 'Фото ' + n + '.jpg', kind: 'photo', status: 'Получаем оригинал' })); });
  await page.waitForFunction(() => document.querySelectorAll('#transfers-list li').length === 50);
  await page.locator('#transfers-scroll').evaluate(el => { el.scrollTop = 400; });
  await page.evaluate(() => { window.transferRow = document.querySelector('#transfers-list li:nth-child(20)'); window.fixture.jobs[1].activeFiles[19].status = '25.0 МБ'; });
  await page.waitForFunction(() => document.querySelector('#transfers-list').textContent.includes('25.0 МБ'));
  assert.equal(await page.locator('#transfers-scroll').evaluate(el => el.scrollTop), 400);
  assert(await page.evaluate(() => window.transferRow === document.querySelector('#transfers-list li:nth-child(20)')));
  await page.screenshot({ path: path.join(output, 'active-downloads-dialog.png') });
  await page.getByRole('button', { name: 'Закрыть текущие скачивания', exact: true }).click();
  await individual.locator('#active-files summary').click();

  assert.equal(await individual.locator('#issues-card').evaluate(el => el.open), false);
  await individual.locator('#issues-open').click();
  const sessionScroll = await page.locator('#session-dialog').evaluate(el => el.scrollTop);
  await page.waitForFunction(() => document.getElementById('diagnostics-dialog').open);
  assert.equal(Math.round((await page.locator('#diagnostics-dialog').boundingBox()).width), 700);
  const nested = page.frameLocator('#diagnostics-frame');
  await nested.locator('#rows tr').first().waitFor();
  assert.equal(await nested.locator('#rows tr').count(), 80);
  assert.equal(await nested.locator('#show-skipped').isChecked(), false);
  assert.equal(context.pages().length, pagesBefore);
  await page.screenshot({ path: path.join(output, 'nested-errors.png') });
  await nested.locator('#close').click();
  await page.waitForFunction(() => !document.getElementById('diagnostics-dialog').open);
  assert.equal(await page.locator('#session-dialog').evaluate(el => el.open), true);
  assert.equal(await page.locator('#session-dialog').evaluate(el => el.scrollTop), sessionScroll);
  assert.equal(await page.locator('#active-files').evaluate(el => el.open), true);
  await individual.evaluate(() => { window.fixture.jobs[1].running = false; window.fixture.jobs[1].completed = true; window.fixture.jobs[1].phase = 'done'; });
  await individual.waitForFunction(() => !document.getElementById('restart-job').disabled);
  await individual.locator('#restart-job').click();
  await individual.waitForFunction(() => window.calls.some(c => c.action === 'scan'));
  const restart = await individual.evaluate(() => window.calls.findLast(c => c.action === 'scan'));
  assert.equal(restart.args.link, 'https://disk.yandex.ru/d/fixture1'); assert.equal(restart.args.mode, 'auto');
  await page.getByRole('button', { name: 'Закрыть сессию', exact: true }).click();
  await page.locator('.session-row[data-id="job-2"] .session-resume').click();
  await page.waitForFunction(() => window.calls.some(c => c.action === 'retry'));
  const retry = await page.evaluate(() => window.calls.findLast(c => c.action === 'retry'));
  assert.equal(retry.args.id, 'job-2'); assert.equal(retry.args.includePreviews, true);
  await page.locator('.session-row[data-id="job-2"] .session-resume').click();
  await page.waitForFunction(() => document.querySelectorAll('.session-row')[1].dataset.id === 'job-2');
  await page.locator('#sessions-retry-previews').uncheck();
  await page.locator('#retry-all').click();
  assert.equal(await page.evaluate(() => window.calls.findLast(c => c.action === 'retryAll').args.includePreviews), false);
  await page.locator('#sessions-retry-previews').check(); await page.locator('#retry-all').click();
  assert.equal(await page.evaluate(() => window.calls.findLast(c => c.action === 'retryAll').args.includePreviews), true);
  const buttonRows = await page.locator('.bulk-actions > button').evaluateAll(buttons => buttons.filter(b => !b.hidden).map(b => b.getBoundingClientRect().y));
  assert(buttonRows.every(y => Math.abs(y - buttonRows[0]) < 2));
  const header = await page.locator('.overall-header').boundingBox(), badges = await page.locator('.overall-header .download-badges').boundingBox();
  assert(Math.abs(header.x + header.width - badges.x - badges.width) < 2);
  await page.locator('#overall-card').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'overall.png') });
  assert.equal(await page.locator('#overall-issues').evaluate(el => el.open), false);
  await page.locator('#overall-issues-open').click();
  const overallDiag = page.frameLocator('#diagnostics-frame'); await overallDiag.locator('#rows tr').first().waitFor();
  assert.equal(await overallDiag.locator('#rows tr').count(), 160);
  await overallDiag.locator('#show-skipped').check();
  await overallDiag.locator('#table-scroll').evaluate(el => { el.scrollTop = 500; });
  await page.waitForTimeout(1700);
  assert.equal(await overallDiag.locator('#table-scroll').evaluate(el => el.scrollTop), 500);
  assert.equal(await overallDiag.locator('body').evaluate(() => window.calls.filter(c => c.action === 'status').length), 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('diagnostics-dialog').open);
  await page.locator('#settings-open').click();
  await page.locator('#reload-vk-tabs').click();
  assert.deepEqual(await page.evaluate(() => window.reloaded), [31, 32]);
  assert.match(await page.locator('#reload-vk-result').textContent(), /Обновлено вкладок: 2/);
  assert.equal(await page.locator('#logging').isChecked(), false);
  await page.locator('#logging').check();
  await page.waitForFunction(() => window.calls.some(c => c.action === 'settings' && c.args.logging === true));
  assert.deepEqual(await page.locator('#completion-repeats option').allTextContents(), ['0','1','2','3']);
  assert.deepEqual(await page.locator('#vk-page-delay option').evaluateAll(options => options.map(option => Number(option.value))), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(await page.locator('#vk-page-delay').inputValue(), '1');
  await page.locator('#vk-page-delay').selectOption('5');
  await page.waitForFunction(() => window.calls.some(c => c.action === 'settings' && c.args.vkPageDelaySeconds === 5));
  assert.deepEqual((await page.locator('#download-limit option').allTextContents()).slice(-3), ['100','150','200']);
  assert.deepEqual((await page.locator('#vk-download-limit option').allTextContents()).slice(-4), ['70+40','100+50','150+70','200+100']);
  const timeoutBox = await page.locator('#download-timeout').boundingBox(), repeatBox = await page.locator('#completion-repeats').boundingBox();
  assert(repeatBox.x > timeoutBox.x && Math.abs(repeatBox.y - timeoutBox.y) < 2);
  await page.locator('#completion-repeats').selectOption('3');
  await page.waitForFunction(() => window.calls.some(c => c.action === 'settings' && c.args.completionRepeats === 3));
  await page.keyboard.press('Escape');
  for (const width of [780,360]) {
    await page.setViewportSize({ width, height: 780 }); await page.locator('#sessions-card').scrollIntoViewIfNeeded();
    assert(await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth));
    assert(await page.locator('#sessions-card').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: path.join(output, 'sessions-' + width + '.png') });
    await page.locator('.session-row').first().locator('.session-open').click();
    assert(await page.locator('#session-dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.locator('#issues-open').click();
    const smallDiag = page.frameLocator('#diagnostics-frame'); await smallDiag.locator('#rows tr').first().waitFor();
    assert(await page.locator('#diagnostics-dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
    assert(await smallDiag.locator('#table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth));
    await smallDiag.locator('#close').click();
    await page.getByRole('button', { name: 'Закрыть сессию', exact: true }).click();
  }
  const diag = await context.newPage(); await diag.setViewportSize({ width: 1100, height: 780 }); await diag.goto(base + '/diagnostics.html');
  await diag.waitForFunction(() => document.querySelectorAll('#rows tr').length === 160);
  assert.equal(await diag.locator('#show-skipped').isChecked(), false); assert.equal(await diag.locator('#rows tr:visible').count(), 110);
  assert.equal(await diag.locator('#rows img').count(), 0);
  assert.equal(await diag.locator('#rows td.session').first().evaluate(el => el.getBoundingClientRect().width), 140);
  await diag.locator('.file-link').first().click();
  assert.equal(await diag.evaluate(() => window.opened.at(-1).url), 'https://disk.yandex.ru/d/example/file%200.jpg');
  await diag.locator('#show-skipped').check(); assert.equal(await diag.locator('#rows tr:visible').count(), 160);
  await diag.evaluate(() => { document.getElementById('table-scroll').scrollTop = 500; window.fixture.jobs[0].issues.length = 0; });
  await diag.waitForTimeout(1800);
  assert.equal(await diag.evaluate(() => document.getElementById('table-scroll').scrollTop), 500);
  assert.equal(await diag.locator('#rows tr').count(), 160);
  assert.equal(await diag.evaluate(() => window.calls.filter(c => c.action === 'status').length), 1);
  await diag.screenshot({ path: path.join(output, 'diagnostics.png') });
  await diag.goto(base + '/diagnostics.html?job=job-1'); await diag.waitForFunction(() => document.querySelectorAll('#rows tr').length === 80);
  assert.equal(await diag.locator('#show-skipped').isChecked(), false); assert.equal(await diag.locator('#rows td.session:visible').count(), 0);
  await diag.setViewportSize({ width: 360, height: 780 });
  assert(await diag.locator('#table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth));
  await diag.goto(base + '/diagnostics.html?job=deleted'); await diag.waitForFunction(() => document.getElementById('message').textContent.includes('удалена'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', output }));
} finally { await context.close(); }
