const $ = id => document.getElementById(id);
let state = { running: false, job: null, jobs: [] }, pending = false, timer, closed = false, revision = 0;
const labels = { scanning: 'Обходим папки', ready: 'Готово к загрузке', downloading: 'Скачиваем файлы', done: 'Готово', stopped: 'Остановлено' };
async function request(action, args = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'command', action, args: { id: state.id, ...args } });
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
  $('retry').disabled = running || state.queued || pending || !job || job.phase === 'stopped' || (!s.failed && !s.directoriesFailed);
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
  if (!job) return;
  $('album').textContent = job.title || 'Получаем название…';
  $('destination').textContent = 'Загрузки / ' + (job.folder || 'yandex-disk / название папки').replaceAll('/', ' / ');
  $('phase').textContent = state.queued ? 'Ожидает свободного места' :
    (!running && ['scanning','downloading'].includes(job.phase) ? 'Пауза · ' : '') + labels[job.phase];
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
$('retry').addEventListener('click', () => act('retry'));
$('report').addEventListener('click', () => act('report'));
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
  const currentUrl = tab?.url || '';
  state = await request('status', { link: currentUrl });
  const oldUrl = state.job ? state.job.publicUrl + (state.job.path === '/' ? '' : state.job.path) : '';
  $('link').value = /^https:\/\/(disk\.yandex\.(ru|com)|yadi\.sk)\/(d|i)\//.test(currentUrl) ? currentUrl : oldUrl;
  if (state.job && $('link').value === oldUrl) {
    $('mode').value = state.job.mode === 'original' ? 'original' : 'auto';
    $('download-all').checked = !state.job.deduplicate;
  }
} catch (error) { state.notice = error.message; }
render();
timer = setTimeout(poll, 700);
