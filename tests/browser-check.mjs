// Opt-in isolated Chromium smoke check. No user profile or Yandex requests.
// PLAYWRIGHT_MODULE and CHROMIUM_PATH may point to an existing test runtime.
import { createRequire } from 'node:module';
import { cp, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve('test-output/browser-check-' + Date.now());
const extension = path.join(root, 'extension'), downloads = path.join(root, 'downloads');
await mkdir(downloads, { recursive: true });
await cp(path.resolve('extension'), extension, { recursive: true });
await writeFile(path.join(extension, 'network.js'), `
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
export async function resource(job) {
  const count = job.publicUrl.split('/').pop().startsWith('idle') ? 1000 : 6;
  return {type:'dir', name:job.publicUrl.split('/').pop(), _embedded:{total:count,offset:0,items:
    Array.from({length:count},(_,n)=>({type:'file',name:n+'.png',path:'/'+n+'.png',size:png.length,media_type:'image'}))}};
}
export async function getPhoto(job, file, kind, signal) {
  if (job.publicUrl.split('/').pop().startsWith('idle')) await chrome.runtime.sendMessage({target:'background',type:'delay',ms:500});
  signal.throwIfAborted();
  if (file.name === '0.png' && kind === 'original' && !job.publicUrl.split('/').pop().startsWith('idle')) throw new Error('Preview fixture');
  return new Blob([png], {type:'image/png'});
}
export async function originalUrl() { throw new Error('No remote downloads in this test'); }
`);
const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
  executablePath: process.env.CHROMIUM_PATH,
  headless: true, viewport: { width: 600, height: 600 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  acceptDownloads: true
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await context.addInitScript(() => {
    if (!window.FileSystemHandle) return;
    const query = FileSystemHandle.prototype.queryPermission;
    const request = FileSystemHandle.prototype.requestPermission;
    FileSystemHandle.prototype.queryPermission = function(options) {
      return window.testFolderPermission ? Promise.resolve(window.testFolderPermission) : query.call(this, options);
    };
    FileSystemHandle.prototype.requestPermission = function(options) {
      window.permissionCalls = (window.permissionCalls || 0) + 1;
      if (window.testFolderPermission) { window.testFolderPermission = 'granted'; return Promise.resolve('granted'); }
      return request.call(this, options);
    };
    // Native OS chooser is the only mocked filesystem API. Returned handles,
    // permissions, IndexedDB serialization and offscreen writes are real.
    window.showDirectoryPicker = async options => {
      window.pickerCalls = (window.pickerCalls || 0) + 1;
      if (!navigator.userActivation.isActive) throw new Error('Picker requires a user gesture');
      if (options.mode !== 'readwrite') throw new Error('Expected readwrite access');
      if (window.cancelPicker) throw new DOMException('Cancelled', 'AbortError');
      return (await navigator.storage.getDirectory()).getDirectoryHandle(window.folderChoice || 'Chosen', { create: true });
    };
  });
  const probe = await context.newPage();
  await probe.addInitScript(() => {
    chrome.tabs.query = async () => [{ url: 'https://disk.yandex.ru/d/FromTab', windowId: 1 }];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let first = true;
    chrome.runtime.sendMessage = (...args) => {
      if (first && args[0]?.action === 'status') {
        first = false;
        return new Promise(resolve => { window.releaseInitialStatus = () => resolve(send(...args)); });
      }
      return send(...args);
    };
  });
  await probe.goto('chrome-extension://' + id + '/app.html');
  await probe.waitForFunction(() => document.getElementById('link').value.endsWith('/FromTab'));
  await probe.locator('#link').fill('https://disk.yandex.ru/d/Manual');
  await probe.evaluate(() => window.releaseInitialStatus());
  await probe.waitForFunction(() => document.getElementById('active-downloads').textContent.length > 0);
  assert.equal(await probe.locator('#link').inputValue(), 'https://disk.yandex.ru/d/Manual');
  await probe.close();
  let page = await context.newPage();
  const errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await page.goto('chrome-extension://' + id + '/app.html');
  await page.waitForFunction(() => document.getElementById('active-downloads').textContent.length > 0);
  const command = (action, args = {}) => page.evaluate(async ({ action, args }) => {
    const result = await chrome.runtime.sendMessage({ target: 'background', type: 'command', action, args });
    if (!result.ok) throw new Error(result.error); return result.value;
  }, { action, args });
  const countFiles = () => page.evaluate(async () => {
    const { loadDownloadFolder } = await import('./storage.js');
    const walk = async dir => {
      let count = 0;
      for await (const [name, handle] of dir.entries()) count += handle.kind === 'directory' ? await walk(handle) : name.endsWith('.png') ? 1 : 0;
      return count;
    };
    return walk(await loadDownloadFolder());
  });
  await assert.rejects(command('scan', { link: 'https://disk.yandex.ru/d/AlbumA' }), /Выберите папку/);
  assert.equal((await command('status')).jobs.length, 0);
  assert.equal(await page.locator('#source-card').evaluate(el => el.open), true);
  // Both the initial choice and changing the folder stay in the current UI.
  // Cancelling must create neither a job nor a file, and never open a tab.
  await page.locator('#link').fill('https://disk.yandex.ru/d/AlbumA');
  const pagesBeforePicker = context.pages().length;
  await page.evaluate(() => { window.cancelPicker = true; });
  await page.locator('#scan').click();
  await page.waitForFunction(() => window.pickerCalls === 1);
  assert.equal(await page.locator('#settings').evaluate(el => el.open), false);
  assert.equal((await command('status')).jobs.length, 0);
  assert.equal(context.pages().length, pagesBeforePicker);
  await page.evaluate(() => { window.cancelPicker = false; });
  await page.locator('#scan').click();
  await page.waitForFunction(() => document.getElementById('folder-warning').hidden && document.getElementById('album').textContent === 'Загрузка — AlbumA');
  assert.equal(await page.locator('#overall-card').isHidden(), true);
  assert.equal(await page.locator('#source-card').evaluate(el => el.open), false);
  await page.locator('#source-heading').click();
  await page.locator('#retry-previews').check(); // re-render without changing the job count
  assert.equal(await page.locator('#source-card').evaluate(el => el.open), true);
  await page.locator('#retry-previews').uncheck();
  await page.locator('#source-heading').click();
  assert.equal(await page.locator('#queue-card').isHidden(), true);
  await page.locator('#download-heading').click();
  assert.equal(await page.locator('#download-card').evaluate(el => el.open), true);
  await page.screenshot({ path: path.join(root, 'single-job.png') });
  assert.equal(context.pages().length, pagesBeforePicker);
  const a = await command('status');
  await page.locator('#settings-open').click();
  await page.locator('#download-timeout').selectOption('120');
  await page.waitForFunction(() => !document.getElementById('download-timeout').disabled);
  assert.equal((await command('status')).timeoutSeconds, 120);
  await page.locator('#download-limit').selectOption('5');
  await page.waitForFunction(() => !document.getElementById('download-limit').disabled);
  assert.equal((await command('status')).downloadLimit, 5);
  await page.keyboard.press('Escape');
  const b = await command('scan', { link: 'https://disk.yandex.ru/d/AlbumB' });
  for (let n = 0; n < 100; n++) {
    if ((await command('status')).jobs.every(j => !j.running && !j.queued)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const complete = await command('status', { id: a.id });
  console.log(JSON.stringify({ summary: complete.job.summary, issues: complete.job.issues, notice: complete.notice }));
  assert.equal(complete.job.summary.originals, 5); assert.equal(complete.job.summary.previews, 1);
  assert.equal(complete.job.summary.newFiles, 6);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('originals').textContent === '5');
  assert.equal(await page.locator('#source-card').evaluate(el => el.open), false);
  assert.equal(await page.locator('#previews').textContent(), '1');
  assert.equal(await page.locator('#job-percent').textContent(), '100%');
  assert.equal(await page.locator('#new-files').textContent(), 'Новых: 6');
  assert.equal(await page.locator('#overall-new-files').textContent(), 'Новых: 12');
  await page.screenshot({ path: path.join(root, 'current-run-badges.png') });
  assert.equal(await page.locator('#overall-card').isVisible(), true);
  assert.equal(await page.locator('#overall-card').evaluate(el => el.tagName), 'SECTION');
  assert.equal(await page.locator('#download-card').evaluate(el => el.open), false);
  assert.equal(await page.locator('#overall-card #jobs').count(), 1);
  assert(await page.locator('#link').evaluate(el => !!(el.compareDocumentPosition(document.getElementById('overall-card')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  await page.locator('#download-heading').click();
  assert.equal(await page.locator('#download-card').evaluate(el => el.open), true);
  await command('status');
  await page.locator('#retry-all-previews').check(); // triggers a render, which must preserve expansion
  assert.equal(await page.locator('#download-card').evaluate(el => el.open), true);
  await page.locator('#retry-all-previews').uncheck();
  await page.locator('#download-heading').click();
  assert.equal(await page.locator('#download-card').evaluate(el => el.open), false);
  assert.equal(await page.locator('#download-completed').isVisible(), true);
  assert.equal(await page.locator('#retry-all').isDisabled(), true);
  await page.locator('#retry-all-previews').check();
  await page.locator('#retry-all').click();
  await page.waitForFunction(() => !document.getElementById('scan').disabled);
  for (let n = 0; n < 100; n++) {
    if ((await command('status')).jobs.every(j => j.completed)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert((await command('status')).jobs.every(j => j.completed));
  assert((await command('status')).jobs.every(j => j.summary.newFiles === 0));
  assert.equal(await countFiles(), 12);
  await page.locator('#download-completed').click();
  await page.waitForFunction(() => !document.getElementById('scan').disabled);
  for (let n = 0; n < 100; n++) {
    if ((await command('status')).jobs.every(j => j.completed)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert((await command('status')).jobs.every(j => j.completed));
  assert.equal(await countFiles(), 12);
  assert.equal((await command('status')).jobs.length, 2);
  await page.waitForFunction(() => document.getElementById('new-files').textContent === 'Новых: 0' && document.getElementById('job-percent').textContent === '100%');
  assert.equal(await page.locator('#overall-new-files').textContent(), 'Новых: 0');
  assert.equal(await page.locator('#job-percent').textContent(), '100%');
  await page.screenshot({ path: path.join(root, 'main.png') });
  await page.locator('#settings-open').click();
  assert.equal(await page.locator('#download-timeout').inputValue(), '120');
  const checkSettingsColumns = async () => {
    const left = await page.locator('#download-limit').boundingBox();
    const right = await page.locator('#download-timeout').boundingBox();
    assert(Math.abs(left.width - right.width) <= 1);
    assert(Math.abs(left.y - right.y) <= 1);
    assert(left.x + left.width < right.x);
  };
  await checkSettingsColumns();
  await page.screenshot({ path: path.join(root, 'settings.png') });
  for (const view of ['tab', 'window']) {
    const expectedSource = await page.locator('#link').inputValue();
    const opened = context.waitForEvent('page');
    await page.locator('#open-' + view).click();
    const other = await opened; await other.waitForLoadState();
    assert.equal(new URL(other.url()).searchParams.get('view'), view);
    await other.waitForFunction(source => document.getElementById('link').value === source, expectedSource);
    await other.close();
  }
  await page.setViewportSize({ width: 360, height: 600 });
  await page.evaluate(() => document.documentElement.classList.add('detached'));
  assert(await page.locator('#settings').evaluate(el => el.scrollWidth <= el.clientWidth));
  await checkSettingsColumns();
  await page.screenshot({ path: path.join(root, 'settings-narrow.png') });
  await page.setViewportSize({ width: 600, height: 600 });
  await page.getByRole('button', { name: 'Удалить задание AlbumA', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#settings-jobs li').length === 1);
  assert.equal((await command('status')).jobs.length, 1);
  assert.equal(await page.locator('#overall-card').isHidden(), true);
  assert.equal(await page.locator('#download-card').evaluate(el => el.open), true);
  await page.getByRole('button', { name: 'Удалить задание AlbumB', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#settings-jobs li').length === 0);
  assert.equal(await page.locator('#source-card').evaluate(el => el.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#originals').textContent(), '0');
  assert.equal(await countFiles(), 12);
  await page.evaluate(async () => {
    const { db } = await import('./storage.js');
    const connection = await db();
    await new Promise((resolve, reject) => {
      const tx = connection.transaction('history', 'readwrite');
      tx.objectStore('history').clear(); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  });
  await command('scan', { link: 'https://disk.yandex.ru/d/AlbumA' });
  for (let n = 0; n < 100; n++) {
    if ((await command('status')).jobs.every(j => !j.running)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await command('status')).job.summary.reused, 6);
  assert.equal(await countFiles(), 12);
  // Change folder from settings: old receipts must not skip files in the new
  // location. Existing content in the old location stays untouched.
  await page.locator('#settings-open').click();
  await page.evaluate(() => { window.folderChoice = 'OtherFolder'; });
  const pagesBeforeChange = context.pages().length;
  await page.locator('#choose-folder').click();
  await page.waitForFunction(() => document.getElementById('folder-status').textContent.startsWith('OtherFolder'));
  assert.equal(context.pages().length, pagesBeforeChange);
  assert.equal(await countFiles(), 0);
  await page.keyboard.press('Escape');
  await command('scan', { link: 'https://disk.yandex.ru/d/AlbumA' });
  await page.waitForFunction(() => document.getElementById('originals').textContent === '5' && document.getElementById('previews').textContent === '1');
  for (let n = 0; n < 100; n++) {
    if ((await command('status')).jobs.every(j => !j.running)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await countFiles(), 6);
  assert.equal((await command('status')).job.summary.reused, 0);
  await page.addInitScript(() => {
    if (!window.FileSystemHandle) return;
    const query = FileSystemHandle.prototype.queryPermission, waiters = [];
    let delayed = true;
    window.releaseFolderRead = () => { delayed = false; waiters.splice(0).forEach(resolve => resolve()); };
    FileSystemHandle.prototype.queryPermission = async function(options) {
      window.folderReadStarted = true;
      if (delayed) await new Promise(resolve => waiters.push(resolve));
      return query.call(this, options);
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.folderReadStarted);
  assert.equal(await page.locator('#scan').isDisabled(), true);
  assert.equal(await page.locator('#folder-warning').isHidden(), true);
  await page.evaluate(() => window.releaseFolderRead());
  await page.waitForFunction(() => document.getElementById('folder-status').textContent.startsWith('OtherFolder'));
  assert.equal(await page.evaluate(() => window.pickerCalls || 0), 0);
  // Restored handle with a genuinely expired grant: request access to that
  // handle, never reopen the directory chooser or the settings dialog.
  await page.evaluate(() => { window.testFolderPermission = 'prompt'; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => document.getElementById('folder-status').textContent.includes('требуется разрешение'));
  await page.locator('#source-heading').click();
  await page.locator('#scan').click();
  await page.waitForFunction(() => document.getElementById('folder-warning').hidden && !document.getElementById('scan').disabled);
  assert.equal(await page.evaluate(() => window.permissionCalls), 1);
  assert.equal(await page.evaluate(() => window.pickerCalls || 0), 0);
  assert.equal(await page.locator('#settings').evaluate(el => el.open), false);
  for (let n = 0; n < 100; n++) {
    if ((await command('status')).jobs.every(j => !j.running)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await countFiles(), 6);
  assert.deepEqual(await readdir(downloads), [], 'New writes must use the selected folder, not Chrome downloads');
  await command('settings', { downloadLimit: 1 });
  const bulkA = await command('scan', { link: 'https://disk.yandex.ru/d/idleA' });
  const bulkB = await command('scan', { link: 'https://disk.yandex.ru/d/idleB' });
  // Reopening the UI must neither ask for a directory nor pause the queue.
  await page.reload();
  await page.waitForFunction(() => window.folderReadStarted);
  await page.evaluate(() => window.releaseFolderRead());
  await page.waitForFunction(() => document.getElementById('folder-status').textContent.includes('доступ разрешён'));
  assert.equal(await page.evaluate(() => window.pickerCalls || 0), 0);
  assert.equal(await page.evaluate(() => window.permissionCalls || 0), 0);
  assert((await command('status')).jobs.some(j => j.running));
  await page.locator('#stop-all').click();
  await page.waitForFunction(() => document.getElementById('stop-all').disabled && !document.getElementById('resume-all').disabled);
  assert.equal((await command('status')).jobs.filter(j => j.resumable).length, 2);
  await page.locator('#resume-all').click();
  await page.waitForFunction(() => !document.getElementById('stop-all').disabled && document.getElementById('resume-all').disabled);
  await page.locator('#pause-all').click();
  await page.waitForFunction(() => document.getElementById('pause-all').disabled && !document.getElementById('resume-all').disabled);
  assert((await command('status')).jobs.every(j => !j.running && !j.queued && j.phase !== 'stopped'));
  await page.locator('#report-all').click();
  await page.waitForFunction(() => !document.getElementById('report-all').disabled);
  const commonReport = await page.evaluate(async () => {
    const { loadDownloadFolder } = await import('./storage.js');
    const dir = await (await loadDownloadFolder()).getDirectoryHandle('yandex-disk');
    for await (const [name, handle] of dir.entries()) if (name.startsWith('download-report-all-')) return (await handle.getFile()).text();
  });
  assert(commonReport.includes('idleA')); assert(commonReport.includes('idleB'));
  await page.locator('#resume-all').click();
  await page.waitForFunction(() => !document.getElementById('pause-all').disabled);
  await command('pause', { id: bulkA.id });
  await page.waitForFunction(() => !document.getElementById('stop-all').disabled && !document.getElementById('resume-all').disabled);
  for (const id of ['stop-all', 'resume-all', 'pause-all', 'report-all', 'download-completed', 'retry-all']) {
    assert.equal(await page.locator('#overall-card #' + id).count(), 1);
  }
  assert.equal(await page.locator('#download-completed').textContent(), 'Повторить всё');
  assert(await page.evaluate(() => ['resume-all', 'pause-all', 'stop-all', 'retry-all', 'report-all'].every((id, n) => {
    const top = getComputedStyle(document.getElementById(id));
    const bottom = getComputedStyle(document.getElementById(['start', 'pause', 'stop', 'retry', 'report'][n]));
    return ['fontSize', 'padding', 'borderRadius', 'backgroundColor'].every(key => top[key] === bottom[key]);
  })));
  await page.locator('#overall-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'bulk-actions.png') });
  await page.setViewportSize({ width: 360, height: 600 });
  await page.evaluate(() => document.documentElement.classList.add('detached'));
  await page.locator('#overall-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'bulk-actions-narrow.png') });
  assert(await page.locator('header').evaluate(el => el.scrollWidth <= el.clientWidth));
  assert(await page.locator('#overall-card').evaluate(el => el.scrollWidth <= el.clientWidth));
  assert(await page.locator('#download-card').evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.setViewportSize({ width: 600, height: 600 });
  await page.locator('#settings-open').click();
  assert.equal(await page.locator('#choose-folder').isDisabled(), false);
  await page.evaluate(() => { window.cancelPicker = true; });
  await page.locator('#choose-folder').click();
  await page.waitForFunction(() => !document.getElementById('choose-folder').disabled);
  assert((await command('status')).jobs.every(j => !j.running && !j.queued));
  assert((await page.locator('#folder-status').textContent()).startsWith('OtherFolder'));
  await page.keyboard.press('Escape');
  await page.locator('#resume-all').click();
  await page.waitForFunction(() => !document.getElementById('stop-all').disabled);
  await page.locator('#settings-open').click();
  await page.evaluate(() => { window.cancelPicker = false; window.folderChoice = 'ChangedWhileRunning'; });
  await page.locator('#choose-folder').click();
  await page.waitForFunction(() => document.getElementById('folder-status').textContent.startsWith('ChangedWhileRunning'));
  assert((await command('status')).jobs.every(j => !j.running && !j.queued));
  assert.equal(await countFiles(), 0);
  await page.keyboard.press('Escape');
  await command('delete', { id: bulkA.id }); await command('delete', { id: bulkB.id });
  // Keep an error and a preview, then simulate reinstall: close the background
  // worker and clear all IndexedDB records (including the directory handle).
  // OPFS represents the external directory selected again by the user.
  await command('scan', { link: 'https://disk.yandex.ru/d/errors', mode: 'original' });
  for (let n = 0; n < 100; n++) {
    if ((await command('status')).jobs.every(j => j.completed)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const beforeReinstall = await command('status');
  assert(beforeReinstall.jobs.some(j => j.summary.failed));
  assert(beforeReinstall.jobs.some(j => j.summary.previews));
  const jsonBefore = await page.evaluate(async () => {
    const { loadDownloadFolder } = await import('./storage.js');
    const dir = await (await loadDownloadFolder()).getDirectoryHandle('yandex-disk');
    return JSON.parse(await (await (await dir.getFileHandle('downloader-state.json')).getFile()).text());
  });
  assert.equal(jsonBefore.extensionVersion, await page.evaluate(() => chrome.runtime.getManifest().version));
  assert.equal(jsonBefore.entries.length, beforeReinstall.jobs.length);
  assert(jsonBefore.history.length > 0);
  await page.close();
  await worker.evaluate(async () => {
    await chrome.offscreen.closeDocument();
    const connection = await new Promise((resolve, reject) => {
      const request = indexedDB.open('yandex-photo-downloader', 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = connection.transaction(['jobs', 'history'], 'readwrite');
      tx.objectStore('jobs').clear(); tx.objectStore('history').clear();
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    connection.close();
  });
  page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/app.html');
  await page.waitForFunction(() => !document.getElementById('choose-folder').disabled);
  assert.equal((await command('status')).jobs.length, 0);
  await page.evaluate(() => { window.folderChoice = 'ChangedWhileRunning'; });
  await page.locator('#settings-open').click();
  await page.locator('#choose-folder').click();
  await page.waitForFunction(() => document.querySelectorAll('#settings-jobs li').length === 2);
  const restored = await command('status');
  assert.deepEqual(restored.jobs.map(j => [j.id, j.summary]), beforeReinstall.jobs.map(j => [j.id, j.summary]));
  assert.equal(restored.timeoutSeconds, beforeReinstall.timeoutSeconds);
  assert.equal(restored.downloadLimit, beforeReinstall.downloadLimit);
  assert(restored.jobs.every(j => !j.running && !j.queued));
  // Selecting an incompatible database must preserve its bytes and the currently
  // selected directory/queue, rather than silently starting with an empty list.
  const futureText = JSON.stringify({ ...jsonBefore, schemaVersion: 999 });
  await page.evaluate(async text => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('FutureFormat', { create: true });
    const dir = await root.getDirectoryHandle('yandex-disk', { create: true });
    const writable = await (await dir.getFileHandle('downloader-state.json', { create: true })).createWritable();
    await writable.write(text); await writable.close(); window.folderChoice = 'FutureFormat';
  }, futureText);
  await page.locator('#choose-folder').click();
  await page.waitForFunction(() => document.getElementById('settings-message').textContent.includes('более новой'));
  assert.equal((await command('status')).jobs.length, 2);
  assert((await page.locator('#folder-status').textContent()).startsWith('ChangedWhileRunning'));
  assert.equal(await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('FutureFormat');
    const dir = await root.getDirectoryHandle('yandex-disk');
    return (await (await dir.getFileHandle('downloader-state.json')).getFile()).text();
  }), futureText);
  await page.keyboard.press('Escape');
  const idleSeconds = Number(process.env.IDLE_SECONDS || 0);
  if (idleSeconds) {
    await command('settings', { downloadLimit: 1 });
    const idle = await command('scan', { link: 'https://disk.yandex.ru/d/idle' });
    await page.close();
    console.log('Idle check started: no popup/status requests for ' + idleSeconds + ' seconds.');
    // No UI, status, filesystem reads or other calls into Chrome during the wait.
    for (let elapsed = 0; elapsed < idleSeconds; elapsed += 30) {
      await new Promise(resolve => setTimeout(resolve, Math.min(30, idleSeconds - elapsed) * 1000));
      console.log('Idle elapsed ' + Math.min(elapsed + 30, idleSeconds) + 's');
    }
    const check = await context.newPage(); await check.goto('chrome-extension://' + id + '/app.html');
    const state = await check.evaluate(id => chrome.runtime.sendMessage({ target:'background', type:'command', action:'pause', args:{id} }), idle.id);
    console.log(JSON.stringify(state));
    assert(state.ok); assert(state.value.job.summary.done >= Math.min(100, Math.floor(idleSeconds / 2)));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', output: root, idleSeconds }));
} finally { await context.close(); }
