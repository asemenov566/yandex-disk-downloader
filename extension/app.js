import { sessionStatus, shortSessionTitle } from './diagnostics-data.js';
import { overallProgress, jobProgress, sortedSessions } from './progress.js';
import { timingText, remainingText } from './timing.js';
import { parseLink } from './core.js';
import { vkPhotosLink } from './vk.js';
import { loadDownloadFolder, stageDownloadFolder, clearFolderCandidate } from './storage.js';

const $ = id => document.getElementById(id);
// A UI preference only: polling progress must never reopen the user's panel.
try { $('overall-card').open = localStorage.getItem('overall-progress-collapsed') !== 'true'; } catch {}
$('overall-card').addEventListener('toggle', () => {
  try { localStorage.setItem('overall-progress-collapsed', String(!$('overall-card').open)); } catch {}
});
const viewParams = new URLSearchParams(location.search);
const individual = viewParams.get('view') === 'individual';
const detached = ['window', 'tab', 'individual'].includes(viewParams.get('view'));
document.documentElement.classList.toggle('individual-view', individual);
document.documentElement.classList.toggle('detached', detached);
if (!individual) $('session-dialog').append($('download-card'));
$('session-dialog').addEventListener('close', () => { $('download-card').hidden = !individual; });
let sourceWindowId = Number(viewParams.get('window')) || undefined;
let state = { running: false, job: null, jobs: [] }, pending = false, timer, closed = false, revision = 0;
let settingsError = '';
let linkEdited = false;
let folderHandle = null, folderAllowed = false;
let folderReady = false, folderRevision = 0;
let deferredDownload = null;
let multipleJobs = false;
let renderedSourceState = '';
const publicLink = value => {
  try {
    const parsed = parseLink(value);
    return parsed.provider === 'vk' ? vkPhotosLink(value) : parsed.publicUrl + (parsed.path === '/' ? '' : parsed.path);
  } catch { return ''; }
};
const sourceBadge = job => {
  try { return parseLink(job.publicUrl).provider === 'vk' ? '[VK]' : '[YD]'; } catch { return ''; }
};
const labels = { scanning: 'Обходим папки', ready: 'Готово к загрузке', downloading: 'Скачиваем файлы', done: 'Готово', stopped: 'Остановлено' };
async function request(action, args = {}) {
  const allIssues = detached && !$('overall-card').hidden && $('overall-issues').open;
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'command', action, args: { id: state.id, allIssues, ...args } });
  if (!response?.ok) throw new Error(response?.error || 'Фоновая очередь не ответила.');
  if (individual && response.value.id !== viewParams.get('job')) return { ...response.value,
    id: viewParams.get('job'), job: null, running: false, queued: false, notice: 'Сессия удалена. Закройте это окно и откройте нужную сессию.' };
  return response.value;
}
function render() {
  const job = state.job, running = state.running, s = job?.summary;
  const nextHasJobs = state.jobs.length > 0;
  // Only a new automatic source opens the panel. Preserve manual toggles
  // during polling; reconsider when the source or its queue membership changes.
  const sourceLink = publicLink($('link').value);
  const sourceKnown = !!sourceLink && state.jobs.some(item =>
    publicLink(item.publicUrl + (!item.path || item.path === '/' ? '' : item.path)) === sourceLink);
  const sourceState = JSON.stringify([sourceLink, nextHasJobs, sourceKnown, linkEdited]);
  if (sourceState !== renderedSourceState) {
    $('source-card').open = !nextHasJobs || (!!sourceLink && (linkEdited || !sourceKnown));
    renderedSourceState = sourceState;
  }
  const anyActive = state.jobs.some(item => item.running || item.queued);
  const completed = state.jobs.filter(item => item.completed);
  $('download-completed').hidden = !completed.length;
  $('download-completed').disabled = pending || !folderReady;
  $('retry-all').disabled = pending || !folderReady || !completed.some(item => item.summary.failed || item.summary.directoriesFailed ||
    ($('sessions-retry-previews').checked && item.summary.previews));
  $('sessions-retry-previews').disabled = pending;
  $('resume-all').disabled = pending || !folderReady || !state.jobs.some(item => item.resumable);
  $('pause-all').disabled = pending || !anyActive;
  $('stop-all').disabled = pending || !anyActive;
  $('report-all').disabled = pending || !folderReady || anyActive || !state.jobs.length;
  $('scan').disabled = pending || !folderReady;
  $('link').disabled = pending;
  $('mode').disabled = pending;
  if (!pending && state.job && publicLink($('link').value) === publicLink(state.job.publicUrl + (state.job.path === '/' ? '' : state.job.path))) {
    $('mode').value = state.job.mode === 'preview' ? 'auto' : state.job.mode;
  }
  $('download-all').disabled = pending;
  $('pause').disabled = pending || (!running && !state.queued);
  $('stop').disabled = pending || !job || job.phase === 'stopped' || (job.phase === 'done' && !running);
  $('start').disabled = !folderReady || running || state.queued || pending || !job || job.phase === 'stopped' || (!s.pending && !job.pendingDirectories && !state.paused);
  $('retry').disabled = !folderReady || running || state.queued || pending || !job || job.phase === 'stopped' || (!s.failed && !s.directoriesFailed && !($('retry-previews').checked && s.previews));
  $('retry-previews').disabled = running || state.queued || pending;
  $('report').disabled = running || pending || !job?.folder;
  $('restart-job').disabled = pending || running || state.queued || !folderReady || !job;
  $('current').textContent = state.current || '';
  renderTransfers();
  renderSessions();
  $('message').textContent = state.notice || '';
  renderSettings();
  if ($('session-dialog').open && (state.id !== $('session-dialog').dataset.job || !state.jobs.some(job => job.id === state.id))) $('session-dialog').close();
  $('download-card').hidden = !individual && !$('session-dialog').open;
  $('download-card').open = true;
  $('download-heading').tabIndex = -1;
  multipleJobs = false;
  renderOverall();
  if (!job) {
    $('album').textContent = 'Загрузка — укажите ссылку';
    $('job-percent').textContent = '0%'; $('new-files').textContent = 'Новых: 0';
    $('destination').textContent = (folderHandle?.name || 'Выбранная папка') + ' / yandex-disk / название альбома';
    for (const key of ['total', 'originals', 'previews', 'skipped', 'failed']) $(key).textContent = '0';
    $('progress').value = 0; $('detail').textContent = ''; $('download-time').textContent = ''; $('issues-card').hidden = true; $('issues-section').hidden = true;
    return;
  }
  $('album').textContent = 'Загрузка — ' + (job.title || 'получаем название…');
  $('destination').textContent = (folderHandle?.name || 'Выбранная папка') + ' / ' + (job.folder || (job.provider === 'vk' ? 'vk-messager / название диалога' : 'yandex-disk / название папки')).replaceAll('/', ' / ');
  const status = running ? sessionStatus({ ...job, running, current: state.current }) : state.paused ? 'Пауза' : state.queued ? 'Ожидает свободного места' :
    (!running && ['scanning','downloading'].includes(job.phase) ? 'Пауза · ' : '') +
    (job.phase === 'downloading' && job.pass ? (job.provider === 'vk' ? (job.downloadType === 'photos' ? 'Фотографии' : job.downloadType === 'videos' ? 'Видео' : 'Фотографии и видео') : job.pass === 'photos' ? 'Сначала фотографии' : 'Видео, документы и остальные файлы') : (job.provider === 'vk' && job.phase === 'scanning' ? 'ВК: получаем вложения' : labels[job.phase]));
  const processed = s.done + s.skipped;
  const percent = s.total ? Math.min(job.pendingDirectories ? 99 : 100, Math.floor(processed / s.total * 100)) : 0;
  $('job-percent').textContent = percent + '%';
  $('new-files').textContent = 'Новых: ' + (s.newFiles || 0).toLocaleString('ru-RU');
  $('total').textContent = s.total.toLocaleString('ru-RU');
  for (const key of ['originals','previews','skipped']) $(key).textContent = s[key].toLocaleString('ru-RU');
  $('failed').textContent = (s.failed + s.directoriesFailed).toLocaleString('ru-RU');
  $('progress').max = 100;
  $('progress').value = percent;
  $('download-time').textContent = remainingText(job) + ' · ' + timingText(job.timing, running);
  $('detail').textContent = status + (job.provider === 'vk' && job.pendingDirectories ? ' · список ещё загружается' : '') + ' · страниц: ' + job.pages + ' · сохранено всего: ' + s.done + ' · уже были: ' + s.reused;
  $('issues-card').hidden = !job.issues.length;
  $('issues-section').hidden = !job.issues.length;
  $('issues').replaceChildren(...job.issues.map(file => {
    const li = document.createElement('li'); li.textContent = file.name + ' — ' + file.reason; return li;
  }));
}
function renderSettings() {
  $('logging').disabled = pending;
  if (!pending) $('logging').checked = state.logging === true;
  $('log-status').textContent = (state.logging ? 'Запись включена' : 'Запись выключена') + ' · ' + (state.logFile || 'Журнал рядом с JSON-базой') + ' · событий за запуск: ' + (state.logCount || 0) + (state.logError ? ' · не удалось записать файл: подтвердите доступ к папке' : '') + (state.logPending ? ' · ожидают записи: ' + state.logPending : '') + (state.logDropped ? ' · потеряно событий из-за недоступности папки: ' + state.logDropped : '');
  $('download-limit').disabled = pending;
  $('vk-download-limit').disabled = pending;
  $('download-timeout').disabled = pending;
  $('vk-page-delay').disabled = pending;
  if (!pending) $('vk-page-delay').value = String(state.vkPageDelaySeconds || 1);
  $('completion-repeats').disabled = pending;
  if (!pending) $('completion-repeats').value = String(state.completionRepeats || 0);
  if (!pending) $('download-limit').value = String(state.downloadLimit || 50);
  if (!pending) $('vk-download-limit').value = String(state.vkDownloadLimit || 30);
  if (!pending) $('download-timeout').value = String(state.timeoutSeconds || 25);
  $('active-downloads').textContent = 'Сейчас скачивается файлов: ' + (state.activeDownloads || 0);
  $('settings-message').textContent = settingsError;
  $('sessions-message').textContent = settingsError;
  $('folder-warning').hidden = !folderReady || folderAllowed;
  $('folder-warning').textContent = folderHandle ? 'Папка сохранена. При запуске подтвердите доступ Chrome к ней — выбирать её заново не нужно.' : 'При первом скачивании выберите папку. Внутри создадим yandex-disk или vk-messager.';
  $('folder-status').textContent = !folderReady ? 'Читаем сохранённую папку…' : folderHandle ? folderHandle.name + (folderAllowed ? ' · доступ разрешён' : ' · папка сохранена, требуется разрешение Chrome') : 'Папка не выбрана.';
  $('choose-folder').textContent = deferredDownload ? 'Выбрать папку и начать' : folderHandle ? 'Изменить папку' : 'Выбрать папку';
  $('choose-folder').disabled = !folderReady || pending;
  $('allow-folder').hidden = !folderHandle || folderAllowed;
  $('settings-empty').hidden = !!state.jobs.length;
  const list = $('settings-jobs');
  for (const row of [...list.children]) if (!state.jobs.some(j => j.id === row.dataset.id)) row.remove();
  for (const job of state.jobs) {
    let row = [...list.children].find(row => row.dataset.id === job.id);
    if (!row) {
      row = document.createElement('li'); row.dataset.id = job.id;
      const copy = document.createElement('div'); copy.className = 'settings-job-copy';
      copy.append(document.createElement('b'), document.createElement('small'));
      const button = document.createElement('button'); button.className = 'delete-job'; button.textContent = 'Удалить';
      button.addEventListener('click', () => act('delete', { id: job.id, selectedId: state.id }));
      row.append(copy, button); list.append(row);
    }
    row.querySelector('b').textContent = sourceBadge(job) + ' ' + job.title;
    row.querySelector('small').textContent = job.publicUrl + (job.path === '/' ? '' : job.path);
    row.querySelector('button').disabled = pending;
    row.querySelector('button').setAttribute('aria-label', 'Удалить задание ' + sourceBadge(job) + ' ' + job.title);
  }
}
function renderOverall() {
  const s = overallProgress(state.jobs);
  $('overall-card').hidden = individual || !s.visible;
  if (individual || !s.visible) return;
  const format = value => value.toLocaleString('ru-RU');
  $('overall-caption').textContent = `Активных ссылок: ${format(s.active)} · обработано ${format(s.processed)} из ${format(s.total)}`;
  $('overall-percent').textContent = s.percent + '%';
  $('overall-new-files').textContent = 'Новых: ' + format(s.newFiles);
  for (const key of ['total', 'originals', 'previews', 'skipped']) $('overall-' + key).textContent = format(s[key]);
  $('overall-failed').textContent = format(s.failed + s.directoriesFailed);
  $('overall-progress').max = 100;
  $('overall-progress').value = s.percent;
  $('overall-time').textContent = timingText(s.timing, s.active > 0);
  $('overall-detail').textContent = `Страниц: ${format(s.pages)} · сохранено всего: ${format(s.done)} · уже были: ${format(s.reused)}`;
  $('overall-scope').textContent = 'Сумма всех заданий в списке, включая завершённые и приостановленные.' +
    (s.scanning ? ' Идёт поиск файлов — общее количество ещё уточняется.' : '');
  $('overall-current').replaceChildren(...state.jobs.filter(j => j.running).map(job => {
    const item = document.createElement('li');
    const title = document.createElement('b'); title.textContent = job.title;
    const detail = document.createElement('span'); detail.textContent = job.current || labels[job.phase];
    item.append(title, detail); return item;
  }));
  const issuesCount = state.jobs.reduce((count, job) => count + (job.issuesTotal || 0), 0);
  $('overall-issues-section').hidden = !issuesCount;
  $('overall-issues').hidden = !issuesCount;
  $('overall-issues-count').textContent = format(issuesCount);
  if (detached && $('overall-issues').open && state.jobs.every(j => Array.isArray(j.issues))) {
    $('overall-issues-loading').hidden = true;
    $('overall-issues-list').replaceChildren(...state.jobs.flatMap(job => job.issues.map(issue => {
      const item = document.createElement('li');
      const path = document.createElement('b'); path.textContent = issue.path || job.title + ' / ' + issue.name;
      const reason = document.createElement('span'); reason.textContent = issue.reason;
      item.append(path, reason); return item;
    })));
  }
}
async function openView(view) {
  const button = $(view === 'window' ? 'open-window' : 'open-tab');
  button.disabled = true;
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const parent = windows.find(w => w.id === sourceWindowId) || windows.find(w => w.focused) || windows[0];
    const url = new URL(chrome.runtime.getURL('app.html'));
    url.searchParams.set('view', view);
    if (state.id) url.searchParams.set('job', state.id);
    const link = publicLink($('link').value);
    if (link) url.searchParams.set('source', link);
    if (parent) url.searchParams.set('window', parent.id);
    if (view === 'window') await chrome.windows.create({ url: url.href, type: 'popup', width: 780, height: 600, focused: true });
    else if (parent) await chrome.tabs.create({ url: url.href, windowId: parent.id, active: true });
    else await chrome.windows.create({ url: url.href, type: 'normal', focused: true });
  } catch (error) { state.notice = error.message; render(); }
  finally { button.disabled = false; }
}
async function act(action, args) {
  revision++; pending = true; settingsError = ''; render();
  try { state = await request(action, args); }
  catch (error) { state.notice = error.message; settingsError = error.message; }
  finally { pending = false; render(); }
}
async function poll() {
  const startedAt = revision;
  try { if (!pending) { const next = await request('status'); if (!pending && startedAt === revision) { state = next; render(); } } }
  catch (error) { $('message').textContent = error.message; }
  if (!closed) timer = setTimeout(poll, state.jobs.some(j => j.running || j.queued) ? 800 : 1500);
}
async function downloadAction(action, args = {}) {
  if (!folderReady) return;
  try {
    if (action === 'scan') parseLink(args.link);
  } catch (error) { state.notice = error.message; render(); return; }
  if (folderAllowed) { await act(action, args); return; }
  deferredDownload = { action, args };
  if (folderHandle) await grantFolderAccess();
  else await chooseFolder();
}
async function finishFolderSetup() {
  renderSettings();
  if (!folderAllowed || !deferredDownload) return;
  const download = deferredDownload; deferredDownload = null;
  const url = new URL(location.href);
  for (const key of ['download', 'mode', 'deduplicate', 'previews', 'settings']) url.searchParams.delete(key);
  history.replaceState(null, '', url);
  $('settings').close();
  await act(download.action, download.args);
}
$('scan').addEventListener('click', () => downloadAction('scan', { link: $('link').value, mode: $('mode').value, deduplicate: !$('download-all').checked }));
$('mode').addEventListener('change', () => {
  if (state.id && state.job && publicLink($('link').value) === publicLink(state.job.publicUrl + (state.job.path === '/' ? '' : state.job.path))) {
    act('mode', { mode: $('mode').value });
  }
});
$('link').addEventListener('input', () => { linkEdited = true; render(); });
$('link').addEventListener('change', () => {
  const link = publicLink($('link').value);
  if (link) { $('link').value = link; render(); }
});
$('start').addEventListener('click', () => downloadAction('start'));
$('resume-all').addEventListener('click', () => downloadAction('resumeAll'));
$('stop-all').addEventListener('click', () => act('stopAll'));
$('pause-all').addEventListener('click', () => act('pauseAll'));
$('report-all').addEventListener('click', () => downloadAction('reportAll'));
$('download-completed').addEventListener('click', () => downloadAction('downloadAll'));
$('retry-all').addEventListener('click', () => downloadAction('retryAll', { includePreviews: $('sessions-retry-previews').checked }));
$('sessions-retry-previews').addEventListener('change', render);
$('pause').addEventListener('click', () => act('pause'));
$('stop').addEventListener('click', () => act('stop'));
$('retry').addEventListener('click', () => downloadAction('retry', { includePreviews: $('retry-previews').checked }));
$('retry-previews').addEventListener('change', render);
$('restart-job').addEventListener('click', () => {
  const job = state.job; if (!job) return;
  downloadAction('scan', { link: job.publicUrl + (job.path === '/' ? '' : job.path), mode: job.mode, deduplicate: job.deduplicate });
});
$('report').addEventListener('click', () => act('report'));
$('settings-open').addEventListener('click', () => $('settings').showModal());
$('settings').addEventListener('close', () => {
  deferredDownload = null;
  const url = new URL(location.href);
  for (const key of ['download', 'mode', 'deduplicate', 'previews', 'settings']) url.searchParams.delete(key);
  history.replaceState(null, '', url);
});
async function chooseFolder(stopDownloads = false) {
  if (stopDownloads) deferredDownload = null;
  pending = true; revision++; render();
  // Start the stop command and picker in the same click. Awaiting stop first
  // could lose the user activation required by the native picker.
  const stopped = stopDownloads ? request('stopAll').then(value => ({ value }), error => ({ error })) : null;
  try {
    const handle = await window.showDirectoryPicker({ id: 'download-folder', mode: 'readwrite', startIn: folderHandle || 'downloads' });
    if (stopped) {
      const result = await stopped;
      if (result.error) throw result.error;
      state = result.value;
    }
    const token = crypto.randomUUID();
    try {
      await stageDownloadFolder(token, handle);
      state = await request('folder', { token });
    } finally { await clearFolderCandidate(token); }
    folderRevision++;
    folderHandle = handle; folderAllowed = true; folderReady = true; settingsError = '';
  } catch (error) {
    if (stopped) {
      const result = await stopped;
      if (result.value) state = result.value;
      if (result.error) error = result.error;
    }
    deferredDownload = null;
    if (error.name !== 'AbortError') { settingsError = error.message; state.notice = error.message; }
    return;
  } finally { pending = false; render(); }
  await finishFolderSetup();
}
$('choose-folder').addEventListener('click', () => chooseFolder(true));
$('allow-folder').addEventListener('click', grantFolderAccess);
async function grantFolderAccess() {
  pending = true; revision++; render();
  try {
    folderAllowed = await folderHandle.requestPermission({ mode: 'readwrite' }) === 'granted';
    if (folderAllowed) {
      const token = crypto.randomUUID();
      try {
        await stageDownloadFolder(token, folderHandle);
        state = await request('folder', { token });
      } finally { await clearFolderCandidate(token); }
    }
  }
  catch (error) { settingsError = error.message; state.notice = error.message; deferredDownload = null; return; }
  finally { pending = false; folderRevision++; render(); }
  if (!folderAllowed) {
    deferredDownload = null;
    state.notice = settingsError || 'Папка сохранена, но Chrome не разрешил доступ. Разрешите доступ в настройках расширения.';
    render(); return;
  }
  await finishFolderSetup();
}
async function refreshFolder() {
  const revision = ++folderRevision;
  const handle = await loadDownloadFolder();
  const allowed = !!handle && await handle.queryPermission({ mode: 'readwrite' }) === 'granted';
  if (revision !== folderRevision) return;
  folderHandle = handle || null;
  folderAllowed = allowed; folderReady = true;
  render();
}
refreshFolder().catch(error => { settingsError = error.message; renderSettings(); });
window.addEventListener('focus', () => refreshFolder().catch(() => {}));
$('download-limit').addEventListener('change', () => act('settings', { downloadLimit: Number($('download-limit').value) }));
$('vk-download-limit').addEventListener('change', () => act('settings', { vkDownloadLimit: Number($('vk-download-limit').value) }));
$('completion-repeats').addEventListener('change', () => act('settings', { completionRepeats: Number($('completion-repeats').value) }));
$('download-timeout').addEventListener('change', () => act('settings', { timeoutSeconds: Number($('download-timeout').value) }));
$('open-window').addEventListener('click', () => openView('window'));
$('open-tab').addEventListener('click', () => openView('tab'));
$('download-heading').addEventListener('click', event => {
  if (!multipleJobs) event.preventDefault();
});
$('overall-issues').addEventListener('toggle', () => {
  if (detached && !$('overall-card').hidden && $('overall-issues').open) act('status');
});
window.addEventListener('pagehide', () => { closed = true; clearTimeout(timer); });
render();
try {
  const [tab] = await chrome.tabs.query({ active: true, ...(sourceWindowId ? { windowId: sourceWindowId } : { currentWindow: true }) });
  sourceWindowId ||= tab?.windowId;
  const currentUrl = (detached && publicLink(viewParams.get('source'))) || publicLink(tab?.url) || publicLink(tab?.pendingUrl) || '';
  // Reading a large saved queue can take time. Fill the tab URL before waiting
  // for it, and never overwrite input entered while initialization is pending.
  if (!linkEdited && currentUrl) $('link').value = currentUrl;
  const startedAt = revision;
  const next = await request('status', { link: currentUrl, ...(viewParams.get('job') ? { id: viewParams.get('job') } : {}) });
  if (startedAt === revision) state = next;
  const oldUrl = state.job ? publicLink(state.job.publicUrl + (state.job.path === '/' ? '' : state.job.path)) : '';
  if (!linkEdited && !$('link').value) $('link').value = oldUrl;
  if (state.job && $('link').value === oldUrl) {
    $('mode').value = state.job.mode === 'preview' ? 'auto' : state.job.mode;
    $('download-all').checked = !state.job.deduplicate;
  }
} catch (error) { state.notice = error.message; }
render();
timer = setTimeout(poll, 700);

async function openDiagnostics(all = false) {
  const button = $(all ? 'overall-issues-open' : 'issues-open');
  button.disabled = true;
  try {
    if (!all && !state.id) throw new Error('Сначала выберите сессию.');
    const url = new URL(chrome.runtime.getURL('diagnostics.html'));
    if (!all) url.searchParams.set('job', state.id);
    url.searchParams.set('embedded', '1');
    $('diagnostics-frame').src = url.href;
    $('diagnostics-dialog').showModal();
  } catch (error) { $('message').textContent = error.message; }
  finally { button.disabled = false; }
}
$('issues-open').addEventListener('click', () => openDiagnostics());
$('overall-issues-open').addEventListener('click', () => openDiagnostics(true));

function renderTransfers() {
  renderTransferDialog();
  const files = state.job?.activeFiles || [], list = $('active-files-list');
  $('active-files-count').textContent = files.length;
  $('active-files-empty').hidden = files.length > 0;
  if ($('active-files').dataset.job !== state.id) {
    $('active-files').dataset.job = state.id || '';
    $('active-files').open = false; list.replaceChildren();
  }
  for (const row of [...list.children]) if (!files.some(file => file.path === row.dataset.path)) row.remove();
  for (const file of files) {
    let row = [...list.children].find(row => row.dataset.path === file.path);
    if (!row) {
      row = document.createElement('li'); row.dataset.path = file.path;
      row.append(document.createElement('b'), document.createElement('span')); list.append(row);
    }
    row.children[0].textContent = file.name; row.children[0].title = file.path;
    row.children[1].textContent = file.status;
  }
}

async function openSession(id) {
  if (!state.jobs.some(job => job.id === id)) return;
  await act('status', { id });
  if (state.id !== id || !state.job) return;
  $('active-files').open = false; $('issues-card').open = false;
  $('session-dialog').dataset.job = id;
  $('session-dialog').showModal(); $('session-dialog').scrollTop = 0; render();
}
function renderSessions() {
  $('sessions-card').hidden = individual || !state.jobs.length;
  if (individual) return;
  const list = $('sessions-list'), jobs = sortedSessions(state.jobs), scroller = document.querySelector('main');
  const anchor = [...list.children].find(row => row.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
  const anchorId = anchor?.dataset.id, anchorTop = anchor?.getBoundingClientRect().top;
  let reordered = false;
  for (const row of [...list.children]) if (!jobs.some(job => job.id === row.dataset.id)) { row.remove(); reordered = true; }
  jobs.forEach((job, index) => {
    let row = [...list.children].find(row => row.dataset.id === job.id);
    if (!row) {
      row = document.createElement('article'); row.className = 'session-row'; row.dataset.id = job.id; row.setAttribute('role', 'listitem');
      // Only static markup enters innerHTML; session data always uses textContent.
      row.innerHTML = '<div class="session-info"><button class="session-icon secondary session-open" type="button" title="Открыть сессию" aria-label="Открыть сессию">↗</button><b class="session-name"></b><span class="session-count">Скачано <strong class="session-done"></strong></span><span class="session-count">Копий <strong class="session-copies"></strong></span><span class="session-count">Всего <strong class="session-total"></strong></span><span class="session-count session-errors-count">Ошибок <strong class="session-errors"></strong></span><span class="session-count session-new-count">Новые <strong class="session-new"></strong></span></div><div class="session-controls"><span class="session-status"></span><button class="session-icon secondary session-resume" type="button"></button></div><progress max="100"></progress><div class="session-timing"><span></span><b></b></div>';
      row.querySelector('.session-open').addEventListener('click', () => openSession(job.id));
      row.querySelector('.session-resume').addEventListener('click', () => {
        const current = state.jobs.find(item => item.id === job.id);
        if (!current) return;
        if (current.running || current.queued) { act('pause', { id: job.id }); return; }
        downloadAction(current.completed ? 'retry' : 'start', { id: job.id, resumeStopped: true,
          includePreviews: $('sessions-retry-previews').checked });
      });
    }
    if (list.children[index] !== row) { list.insertBefore(row, list.children[index] || null); reordered = true; }
    const name = row.querySelector('.session-name');
    name.textContent = sourceBadge(job) + ' ' + shortSessionTitle(job.title); name.title = sourceBadge(job) + ' ' + job.title;
    row.querySelector('.session-done').textContent = job.done;
    row.querySelector('.session-copies').textContent = job.summary?.previews || 0;
    row.querySelector('.session-total').textContent = job.total;
    row.querySelector('.session-new').textContent = job.summary?.newFiles || 0;
    row.querySelector('.session-errors').textContent = (job.summary?.failed || 0) + (job.summary?.directoriesFailed || 0);
    const status = row.querySelector('.session-status'), text = sessionStatus(job);
    if (status.textContent !== text) status.textContent = text; status.title = text;
    const resume = row.querySelector('.session-resume'), working = job.running || job.queued;
    resume.textContent = working ? 'Ⅱ' : job.completed ? '↻' : '▶';
    resume.title = working ? 'Пауза' : job.completed ? 'Повторить ошибки' + ($('sessions-retry-previews').checked ? ' и preview' : '') : 'Продолжить';
    resume.setAttribute('aria-label', resume.title);
    resume.disabled = pending || (!working && !folderReady);
    const percent = jobProgress(job), timing = remainingText(job) + ' · ' + timingText(job.timing, job.running);
    const progress = row.querySelector('progress'); progress.value = percent; progress.setAttribute('aria-label', 'Прогресс ' + job.title);
    const caption = row.querySelector('.session-timing');
    if (caption.firstChild.textContent !== timing) caption.firstChild.textContent = timing;
    caption.firstChild.title = timing; caption.lastChild.textContent = percent + '%';
    row.classList.toggle('completed', job.completed);
  });
  if (reordered && anchorId && scroller.scrollTop > 0) {
    const next = [...list.children].find(row => row.dataset.id === anchorId);
    if (next) scroller.scrollTop += next.getBoundingClientRect().top - anchorTop;
  }
}


$('diagnostics-dialog').addEventListener('close', () => { $('diagnostics-frame').src = 'about:blank'; });
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== $('diagnostics-frame').contentWindow) return;
  if (event.data?.type === 'close-diagnostics') $('diagnostics-dialog').close();
});

function renderTransferDialog() {
  const dialog = $('transfers-dialog');
  if (!dialog.open) return;
  if (dialog.dataset.job !== state.id || !state.job) { dialog.close(); return; }
  const files = state.job.activeFiles || [], list = $('transfers-list'), scroll = $('transfers-scroll');
  const anchor = [...list.children].find(row => row.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top);
  const anchorPath = anchor?.dataset.path, anchorTop = anchor?.getBoundingClientRect().top, oldScroll = scroll.scrollTop;
  const wanted = new Set(files.map(file => file.path));
  for (const row of [...list.children]) if (!wanted.has(row.dataset.path)) row.remove();
  const rows = new Map([...list.children].map(row => [row.dataset.path, row]));
  for (const file of files) {
    let row = rows.get(file.path);
    if (!row) {
      row = document.createElement('li'); row.dataset.path = file.path;
      row.append(document.createElement('b'), document.createElement('span')); list.append(row);
    }
    row.children[0].textContent = (file.kind === 'video' ? 'Видео · ' : 'Фото · ') + file.name;
    row.children[0].title = file.path;
    row.children[1].textContent = file.status;
  }
  $('transfers-caption').textContent = state.job.title + ' · файлов: ' + files.length + ' · обновляется автоматически';
  $('transfers-empty').hidden = files.length > 0;
  const next = [...list.children].find(row => row.dataset.path === anchorPath);
  scroll.scrollTop = next && oldScroll > 0 ? oldScroll + next.getBoundingClientRect().top - anchorTop : oldScroll;
}
$('active-files-open').addEventListener('click', () => {
  if (!state.job) return;
  $('transfers-dialog').dataset.job = state.id;
  $('transfers-list').replaceChildren();
  $('transfers-dialog').showModal(); renderTransferDialog(); $('transfers-scroll').scrollTop = 0;
});
$('session-dialog').addEventListener('close', () => $('transfers-dialog').close());

$('logging').addEventListener('change', () => act('settings', { logging: $('logging').checked }));
$('clear-log').addEventListener('click', () => act('clearLog'));
$('export-log').addEventListener('click', async () => {
  $('export-log').disabled = true;
  let url;
  try {
    const { text } = await request('exportLog');
    url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    await chrome.downloads.download({ url, filename: (state.logFile || 'downloader.log').split('/').at(-1), saveAs: true });
  } catch (error) { $('settings-message').textContent = error.message; }
  finally { $('export-log').disabled = false; if (url) setTimeout(() => URL.revokeObjectURL(url), 60000); }
});
$('reload-vk-tabs').addEventListener('click', async () => {
  $('reload-vk-tabs').disabled = true;
  $('reload-vk-result').textContent = 'Обновляем вкладки ВК…';
  try {
    const tabs = await chrome.tabs.query({ url: ['https://vk.ru/*', 'https://*.vk.ru/*', 'https://vk.com/*', 'https://*.vk.com/*'] });
    const results = await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => chrome.tabs.reload(tab.id)));
    const failed = results.filter(result => result.status === 'rejected').length;
    $('reload-vk-result').textContent = results.length ? 'Обновлено вкладок: ' + (results.length - failed) + (failed ? ' · не удалось: ' + failed : '') : 'Открытых вкладок ВК нет.';
  } catch (error) { $('reload-vk-result').textContent = error.message; }
  finally { $('reload-vk-tabs').disabled = false; }
});

$('vk-page-delay').addEventListener('change', () => act('settings', { vkPageDelaySeconds: Number($('vk-page-delay').value) }));
