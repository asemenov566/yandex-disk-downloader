import { overallProgress } from './progress.js';
import { parseLink } from './core.js';
import { loadDownloadFolder, stageDownloadFolder, clearFolderCandidate } from './storage.js';

const $ = id => document.getElementById(id);
const viewParams = new URLSearchParams(location.search);
const detached = ['window', 'tab'].includes(viewParams.get('view'));
document.documentElement.classList.toggle('detached', detached);
let sourceWindowId = Number(viewParams.get('window')) || undefined;
let state = { running: false, job: null, jobs: [] }, pending = false, timer, closed = false, revision = 0;
let settingsError = '';
let linkEdited = false;
let folderHandle = null, folderAllowed = false;
let folderReady = false, folderRevision = 0;
let deferredDownload = null;
let multipleJobs = false;
let hasJobs = false;
const publicLink = value => {
  try { parseLink(value); return value; } catch { return ''; }
};
const labels = { scanning: 'Обходим папки', ready: 'Готово к загрузке', downloading: 'Скачиваем файлы', done: 'Готово', stopped: 'Остановлено' };
async function request(action, args = {}) {
  const allIssues = detached && !$('overall-card').hidden && $('overall-issues').open;
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'command', action, args: { id: state.id, allIssues, ...args } });
  if (!response?.ok) throw new Error(response?.error || 'Фоновая очередь не ответила.');
  return response.value;
}
function render() {
  const job = state.job, running = state.running, s = job?.summary;
  const nextHasJobs = state.jobs.length > 0;
  // Set the default only when switching between an empty and nonempty list.
  // Progress updates must preserve the user's manual expansion or collapse.
  if (nextHasJobs !== hasJobs) $('source-card').open = !nextHasJobs;
  hasJobs = nextHasJobs;
  const anyActive = state.jobs.some(item => item.running || item.queued);
  const completed = state.jobs.filter(item => item.completed);
  $('download-completed').hidden = !completed.length;
  $('download-completed').disabled = pending || !folderReady;
  $('retry-all').disabled = pending || !folderReady || !completed.some(item => item.summary.failed || item.summary.directoriesFailed ||
    ($('retry-all-previews').checked && item.summary.previews));
  $('retry-all-previews').disabled = pending;
  $('resume-all').disabled = pending || !folderReady || !state.jobs.some(item => item.resumable);
  $('pause-all').disabled = pending || !anyActive;
  $('stop-all').disabled = pending || !anyActive;
  $('report-all').disabled = pending || !folderReady || anyActive || !state.jobs.length;
  $('scan').disabled = pending || !folderReady;
  $('link').disabled = pending;
  $('mode').disabled = pending;
  $('download-all').disabled = pending;
  $('pause').disabled = pending || (!running && !state.queued);
  $('stop').disabled = pending || !job || job.phase === 'stopped' || (job.phase === 'done' && !running);
  $('start').disabled = !folderReady || running || state.queued || pending || !job || job.phase === 'stopped' || (!s.pending && !job.pendingDirectories);
  $('retry').disabled = !folderReady || running || state.queued || pending || !job || job.phase === 'stopped' || (!s.failed && !s.directoriesFailed && !($('retry-previews').checked && s.previews));
  $('retry-previews').disabled = running || state.queued || pending;
  $('report').disabled = running || pending || !job?.folder;
  $('current').textContent = state.current || '';
  $('message').textContent = state.notice || '';
  renderSettings();
  const select = $('jobs');
  const options = state.jobs.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    const status = item.queued ? 'ожидает' : item.running ? 'скачивается' : item.phase === 'done' ? 'готово' : item.phase === 'stopped' ? 'стоп' : 'пауза';
    option.textContent = item.title + ' · ' + item.done + '/' + item.total + ' · ' + status;
    return option;
  });
  if (document.activeElement !== select || !select.options.length) select.replaceChildren(...options);
  select.value = state.id || '';
  const multiple = state.jobs.length > 1;
  $('queue-card').hidden = !multiple;
  if (multiple !== multipleJobs) $('download-card').open = !multiple;
  if (!multiple) $('download-card').open = true;
  multipleJobs = multiple;
  $('download-card').classList.toggle('collapsible', multiple);
  $('download-heading').tabIndex = multiple ? 0 : -1;
  renderOverall();
  if (!job) {
    $('album').textContent = 'Загрузка — укажите ссылку';
    $('job-percent').textContent = '0%'; $('new-files').textContent = 'Новых: 0';
    $('destination').textContent = (folderHandle?.name || 'Выбранная папка') + ' / yandex-disk / название альбома';
    for (const key of ['total', 'originals', 'previews', 'skipped', 'failed']) $(key).textContent = '0';
    $('progress').value = 0; $('detail').textContent = ''; $('issues-card').hidden = true;
    return;
  }
  $('album').textContent = 'Загрузка — ' + (job.title || 'получаем название…');
  $('destination').textContent = (folderHandle?.name || 'Выбранная папка') + ' / ' + (job.folder || 'yandex-disk / название папки').replaceAll('/', ' / ');
  const status = state.queued ? 'Ожидает свободного места' :
    (!running && ['scanning','downloading'].includes(job.phase) ? 'Пауза · ' : '') +
    (job.phase === 'downloading' && job.pass ? (job.pass === 'photos' ? 'Сначала фотографии' : 'Видео, документы и остальные файлы') : labels[job.phase]);
  const processed = s.done + s.failed + s.skipped;
  $('job-percent').textContent = (s.total ? Math.min(100, Math.floor(processed / s.total * 100)) : 0) + '%';
  $('new-files').textContent = 'Новых: ' + (s.newFiles || 0).toLocaleString('ru-RU');
  $('total').textContent = s.total.toLocaleString('ru-RU');
  for (const key of ['originals','previews','skipped']) $(key).textContent = s[key].toLocaleString('ru-RU');
  $('failed').textContent = (s.failed + s.directoriesFailed).toLocaleString('ru-RU');
  $('progress').max = Math.max(1, s.total);
  $('progress').value = s.done + s.failed + s.skipped;
  $('detail').textContent = status + ' · страниц: ' + job.pages + ' · сохранено всего: ' + s.done + ' · уже были: ' + s.reused;
  $('issues-card').hidden = !job.issues.length;
  $('issues').replaceChildren(...job.issues.map(file => {
    const li = document.createElement('li'); li.textContent = file.name + ' — ' + file.reason; return li;
  }));
}
function renderSettings() {
  $('download-limit').disabled = pending;
  $('download-timeout').disabled = pending;
  if (!pending) $('download-limit').value = String(state.downloadLimit || 1);
  if (!pending) $('download-timeout').value = String(state.timeoutSeconds || 25);
  $('active-downloads').textContent = 'Сейчас скачивается файлов: ' + (state.activeDownloads || 0);
  $('settings-message').textContent = settingsError;
  $('folder-warning').hidden = !folderReady || folderAllowed;
  $('folder-warning').textContent = folderHandle ? 'Папка сохранена. При запуске подтвердите доступ Chrome к ней — выбирать её заново не нужно.' : 'При первом скачивании выберите папку. Внутри создадим yandex-disk или используем уже существующую.';
  $('folder-status').textContent = !folderReady ? 'Читаем сохранённую папку…' : folderHandle ? folderHandle.name + (folderAllowed ? ' / yandex-disk · доступ разрешён' : ' · папка сохранена, требуется разрешение Chrome') : 'Папка не выбрана.';
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
    row.querySelector('b').textContent = job.title;
    row.querySelector('small').textContent = job.publicUrl + (job.path === '/' ? '' : job.path);
    row.querySelector('button').disabled = pending;
    row.querySelector('button').setAttribute('aria-label', 'Удалить задание ' + job.title);
  }
}
function renderOverall() {
  const s = overallProgress(state.jobs);
  $('overall-card').hidden = !s.visible;
  if (!s.visible) return;
  const format = value => value.toLocaleString('ru-RU');
  $('overall-caption').textContent = `Активных ссылок: ${format(s.active)} · обработано ${format(s.processed)} из ${format(s.total)}`;
  $('overall-percent').textContent = s.percent + '%';
  $('overall-new-files').textContent = 'Новых: ' + format(s.newFiles);
  for (const key of ['total', 'originals', 'previews', 'skipped']) $('overall-' + key).textContent = format(s[key]);
  $('overall-failed').textContent = format(s.failed + s.directoriesFailed);
  $('overall-progress').max = Math.max(1, s.total);
  $('overall-progress').value = s.processed;
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
  $('overall-issues').hidden = !detached || !issuesCount;
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
    if (view === 'window') await chrome.windows.create({ url: url.href, type: 'popup', width: 600, height: 600, focused: true });
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
$('link').addEventListener('input', () => { linkEdited = true; });
$('start').addEventListener('click', () => downloadAction('start'));
$('resume-all').addEventListener('click', () => downloadAction('resumeAll'));
$('stop-all').addEventListener('click', () => act('stopAll'));
$('pause-all').addEventListener('click', () => act('pauseAll'));
$('report-all').addEventListener('click', () => downloadAction('reportAll'));
$('download-completed').addEventListener('click', () => downloadAction('downloadAll'));
$('retry-all').addEventListener('click', () => downloadAction('retryAll', { includePreviews: $('retry-all-previews').checked }));
$('retry-all-previews').addEventListener('change', render);
$('pause').addEventListener('click', () => act('pause'));
$('stop').addEventListener('click', () => act('stop'));
$('retry').addEventListener('click', () => downloadAction('retry', { includePreviews: $('retry-previews').checked }));
$('retry-previews').addEventListener('change', render);
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
$('download-timeout').addEventListener('change', () => act('settings', { timeoutSeconds: Number($('download-timeout').value) }));
$('open-window').addEventListener('click', () => openView('window'));
$('open-tab').addEventListener('click', () => openView('tab'));
$('download-heading').addEventListener('click', event => {
  if (!multipleJobs) event.preventDefault();
});
$('overall-issues').addEventListener('toggle', () => {
  if (detached && !$('overall-card').hidden && $('overall-issues').open) act('status');
});
$('jobs').addEventListener('change', async () => {
  linkEdited = true;
  await act('status', { id: $('jobs').value });
  if (state.job) {
    $('link').value = state.job.publicUrl + (state.job.path === '/' ? '' : state.job.path);
    $('mode').value = state.job.mode === 'original' ? 'original' : 'auto';
    $('download-all').checked = !state.job.deduplicate;
  }
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
  const oldUrl = state.job ? state.job.publicUrl + (state.job.path === '/' ? '' : state.job.path) : '';
  if (!linkEdited && !$('link').value) $('link').value = oldUrl;
  if (state.job && $('link').value === oldUrl) {
    $('mode').value = state.job.mode === 'original' ? 'original' : 'auto';
    $('download-all').checked = !state.job.deduplicate;
  }
} catch (error) { state.notice = error.message; }
render();
timer = setTimeout(poll, 700);
