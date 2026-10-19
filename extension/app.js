import { overallProgress } from './progress.js';

const $ = id => document.getElementById(id);
const viewParams = new URLSearchParams(location.search);
const detached = ['window', 'tab'].includes(viewParams.get('view'));
document.documentElement.classList.toggle('detached', detached);
let sourceWindowId = Number(viewParams.get('window')) || undefined;
let state = { running: false, job: null, jobs: [] }, pending = false, timer, closed = false, revision = 0;
const labels = { scanning: 'Обходим папки', ready: 'Готово к загрузке', downloading: 'Скачиваем файлы', done: 'Готово', stopped: 'Остановлено' };
async function request(action, args = {}) {
  const allIssues = detached && $('overall-card').open && $('overall-issues').open;
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'command', action, args: { id: state.id, allIssues, ...args } });
  if (!response?.ok) throw new Error(response?.error || 'Фоновая очередь не ответила.');
  return response.value;
}
function render() {
  const job = state.job, running = state.running, s = job?.summary;
  $('scan').disabled = pending;
  $('link').disabled = pending;
  $('mode').disabled = pending;
  $('download-all').disabled = pending;
  $('pause').disabled = pending || (!running && !state.queued);
  $('stop').disabled = pending || !job || job.phase === 'stopped' || (job.phase === 'done' && !running);
  $('start').disabled = running || state.queued || pending || !job || job.phase === 'stopped' || (!s.pending && !job.pendingDirectories);
  $('retry').disabled = running || state.queued || pending || !job || job.phase === 'stopped' || (!s.failed && !s.directoriesFailed && !($('retry-previews').checked && s.previews));
  $('retry-previews').disabled = running || state.queued || pending;
  $('report').disabled = running || pending || !job?.folder;
  $('current').textContent = state.current || '';
  $('message').textContent = state.notice || '';
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
  $('queue-card').hidden = !state.jobs.length;
  renderOverall();
  if (!job) return;
  $('album').textContent = job.title || 'Получаем название…';
  $('destination').textContent = 'Загрузки / ' + (job.folder || 'yandex-disk / название папки').replaceAll('/', ' / ');
  $('phase').textContent = state.queued ? 'Ожидает свободного места' :
    (!running && ['scanning','downloading'].includes(job.phase) ? 'Пауза · ' : '') +
    (job.phase === 'downloading' && job.pass ? (job.pass === 'photos' ? 'Сначала фотографии' : 'Видео, документы и остальные файлы') : labels[job.phase]);
  $('quality').textContent = job.usePreviews ? 'Фото: копии' : job.mode === 'original' ? 'Оригиналы' : 'Авто';
  $('total').textContent = s.total.toLocaleString('ru-RU');
  for (const key of ['done','skipped']) $(key).textContent = s[key].toLocaleString('ru-RU');
  $('failed').textContent = (s.failed + s.directoriesFailed).toLocaleString('ru-RU');
  $('progress').max = Math.max(1, s.total);
  $('progress').value = s.done + s.failed + s.skipped;
  $('detail').textContent = 'Страниц: ' + job.pages + ' · уже были: ' + s.reused + ' · оригиналов: ' + s.originals + ' · копий: ' + s.previews;
  $('issues-card').hidden = !job.issues.length;
  $('issues').replaceChildren(...job.issues.map(file => {
    const li = document.createElement('li'); li.textContent = file.name + ' — ' + file.reason; return li;
  }));
}
function renderOverall() {
  const s = overallProgress(state.jobs);
  $('overall-card').hidden = !s.visible;
  if (!s.visible) return;
  const format = value => value.toLocaleString('ru-RU');
  $('overall-caption').textContent = `Активных ссылок: ${format(s.active)} · обработано ${format(s.processed)} из ${format(s.total)}`;
  $('overall-percent').textContent = s.percent + '%';
  for (const key of ['total', 'done', 'skipped']) $('overall-' + key).textContent = format(s[key]);
  $('overall-failed').textContent = format(s.failed + s.directoriesFailed);
  $('overall-progress').max = Math.max(1, s.total);
  $('overall-progress').value = s.processed;
  $('overall-detail').textContent = `Страниц: ${format(s.pages)} · уже были: ${format(s.reused)} · оригиналов: ${format(s.originals)} · копий: ${format(s.previews)}`;
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
    if (parent) url.searchParams.set('window', parent.id);
    if (view === 'window') await chrome.windows.create({ url: url.href, type: 'popup', width: 600, height: 600, focused: true });
    else if (parent) await chrome.tabs.create({ url: url.href, windowId: parent.id, active: true });
    else await chrome.windows.create({ url: url.href, type: 'normal', focused: true });
  } catch (error) { state.notice = error.message; render(); }
  finally { button.disabled = false; }
}
async function act(action, args) {
  revision++; pending = true; render();
  try { state = await request(action, args); }
  catch (error) { state.notice = error.message; }
  finally { pending = false; render(); }
}
async function poll() {
  const startedAt = revision;
  try { if (!pending) { const next = await request('status'); if (!pending && startedAt === revision) { state = next; render(); } } }
  catch (error) { $('message').textContent = error.message; }
  if (!closed) timer = setTimeout(poll, state.jobs.some(j => j.running || j.queued) ? 800 : 1500);
}
$('scan').addEventListener('click', () => act('scan', { link: $('link').value, mode: $('mode').value, deduplicate: !$('download-all').checked }));
$('start').addEventListener('click', () => act('start'));
$('pause').addEventListener('click', () => act('pause'));
$('stop').addEventListener('click', () => act('stop'));
$('retry').addEventListener('click', () => act('retry', { includePreviews: $('retry-previews').checked }));
$('retry-previews').addEventListener('change', render);
$('report').addEventListener('click', () => act('report'));
$('open-window').addEventListener('click', () => openView('window'));
$('open-tab').addEventListener('click', () => openView('tab'));
for (const id of ['overall-card', 'overall-issues']) $(id).addEventListener('toggle', () => {
  if (detached && $('overall-card').open && $('overall-issues').open) act('status');
});
$('jobs').addEventListener('change', async () => {
  await act('status', { id: $('jobs').value });
  if (state.job) {
    $('link').value = state.job.publicUrl + (state.job.path === '/' ? '' : state.job.path);
    $('mode').value = state.job.mode === 'original' ? 'original' : 'auto';
    $('download-all').checked = !state.job.deduplicate;
  }
});
window.addEventListener('pagehide', () => { closed = true; clearTimeout(timer); });
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  sourceWindowId ||= tab?.windowId;
  const currentUrl = tab?.url || '';
  state = await request('status', { link: currentUrl, ...(viewParams.get('job') ? { id: viewParams.get('job') } : {}) });
  const oldUrl = state.job ? state.job.publicUrl + (state.job.path === '/' ? '' : state.job.path) : '';
  $('link').value = /^https:\/\/(disk\.yandex\.(ru|com)|yadi\.sk)\/(d|i)\//.test(currentUrl) ? currentUrl : oldUrl;
  if (state.job && $('link').value === oldUrl) {
    $('mode').value = state.job.mode === 'original' ? 'original' : 'auto';
    $('download-all').checked = !state.job.deduplicate;
  }
} catch (error) { state.notice = error.message; }
render();
timer = setTimeout(poll, 700);
