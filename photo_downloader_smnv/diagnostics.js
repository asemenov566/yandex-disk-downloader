import { diagnosticRows, shortSessionTitle } from './diagnostics-data.js';
const $ = id => document.getElementById(id);
const jobId = new URLSearchParams(location.search).get('job') || '';
document.body.classList.toggle('individual', !!jobId);
const embedded = new URLSearchParams(location.search).get('embedded') === '1';
document.body.classList.toggle('embedded', embedded);
function closeDiagnostics() {
  if (embedded && window.parent !== window) window.parent.postMessage({ type: 'close-diagnostics' }, location.origin);
  else window.close();
}
$('close').addEventListener('click', closeDiagnostics);
if (embedded) document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeDiagnostics(); }
});
let rows = [];
function filter() {
  const scroller = $('table-scroll'), top = scroller.scrollTop, left = scroller.scrollLeft;
  let shown = 0;
  for (const row of rows) {
    row.hidden = row.dataset.state === 'skipped' && !$('show-skipped').checked;
    if (!row.hidden) shown++;
  }
  $('count').textContent = 'Показано: ' + shown + ' из ' + rows.length;
  $('message').textContent = shown ? '' : $('show-skipped').checked ? 'Ошибок и пропусков нет.' : 'Ошибок нет. Пропущенные файлы можно показать галочкой.';
  scroller.scrollTop = top; scroller.scrollLeft = left;
}
$('show-skipped').checked = false;
$('show-skipped').addEventListener('change', filter);
try {
  // One read on opening. Neither progress polling nor filtering refetches data.
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'command', action: 'status', args: { id: jobId || undefined, allIssues: true } });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось получить список.');
  const state = response.value;
  const job = state.jobs.find(j => j.id === jobId);
  if (jobId && !job) throw new Error('Эта сессия уже удалена. Откройте список из нужной сессии.');
  $('title').textContent = job ? 'Ошибки и пропуски — ' + job.title : 'Ошибки и пропуски всех сессий';
  document.title = $('title').textContent;
  $('snapshot').textContent = 'Снимок на ' + new Date().toLocaleString('ru-RU') + '. Для нового снимка откройте окно заново.';
  rows = diagnosticRows(state, jobId).map(issue => {
    const row = document.createElement('tr'); row.dataset.state = issue.state;
    const linkCell = document.createElement('td');
    if (issue.url && /^https:\/\//.test(issue.url)) {
      const link = document.createElement('a'); link.className = 'file-link'; link.textContent = '↗'; link.href = issue.url;
      link.title = 'Открыть файл в отдельном окне'; link.setAttribute('aria-label', 'Открыть ' + issue.name);
      link.addEventListener('click', async event => {
        event.preventDefault();
        try { await chrome.windows.create({ url: issue.url, type: 'popup', width: 1100, height: 800, focused: true }); }
        catch (error) { $('message').textContent = 'Не удалось открыть файл: ' + error.message; }
      }); linkCell.append(link);
    } else { linkCell.textContent = '—'; linkCell.className = 'unavailable'; linkCell.title = 'Адрес файла недоступен'; }
    const session = document.createElement('td'); session.className = 'session'; session.textContent = issue.badge + ' ' + shortSessionTitle(issue.session); session.title = issue.badge + ' ' + issue.session;
    const file = document.createElement('td'); file.textContent = issue.path || issue.name;
    const status = document.createElement('td'); status.className = issue.state === 'skipped' ? 'skipped' : 'failed'; status.textContent = issue.state === 'skipped' ? 'Пропущено' : 'Ошибка';
    const reason = document.createElement('td'); reason.textContent = issue.reason || 'Причина не указана';
    row.append(linkCell, session, file, status, reason); return row;
  });
  $('rows').replaceChildren(...rows); filter();
} catch (error) { $('snapshot').textContent = ''; $('message').textContent = error.message; $('show-skipped').disabled = true; }
