import { parseLink } from './core.js';

// Construct only service URLs. Never pass arbitrary persisted URLs to a window.
export function issueLink(job, file) {
  try {
    const source = parseLink(job.publicUrl);
    if (source.provider !== 'vk') {
      const parts = (file.path || '/').split('/').filter(Boolean);
      if (parts.some(p => p === '.' || p === '..')) return '';
      return source.publicUrl + (parts.length ? '/' + parts.map(encodeURIComponent).join('/') : '');
    }
    // Photos use the messenger viewer's private-photo key, never a CDN URL.
    const id = (file.path || '').replace(/^\//, '');
    if (/^photo-?\d+_\d+$/.test(id)) {
      const key = /^[a-f0-9]{1,128}$/i.test(file.vk?.accessKey || '') ? file.vk.accessKey : '';
      return 'https://vk.ru/im?z=' + id + (key ? '/' + key : '');
    }
    const url = new URL(source.publicUrl);
    url.searchParams.set('rp', 'peer' + source.peerId);
    if (/^(photo|video)-?\d+_\d+$/.test(id)) {
      const context = id.startsWith('photo') && Number.isSafeInteger(file.vk?.cmid) ? '/mail' + source.peerId + '-' + file.vk.cmid : '';
      url.searchParams.set('z', id + context);
    }
    return url.href;
  } catch { return ''; }
}

export function diagnosticRows(state, jobId = '') {
  return (state.jobs || []).filter(job => !jobId || job.id === jobId).flatMap(job =>
    (job.issues || []).map(issue => ({ ...issue, jobId: job.id, session: job.title || job.publicUrl,
      badge: job.publicUrl?.includes('vk.') ? '[VK]' : '[YD]' })));
}

export function sessionStatus(job) {
  if (job.queued) return 'ожидает запуска';
  if (job.running) return (job.autoRepeats ? 'Повтор ' + job.autoRepeats + '/' + job.completionRepeats + ' · ' : '') + (job.current || (job.phase === 'scanning' ? 'получаем список файлов' : 'подготовка скачивания'));
  if (job.paused) return 'пауза';
  if (job.phase === 'stopped') return 'остановлено';
  if (job.notice && !job.notice.startsWith('Готово') && !job.notice.startsWith('Приостановлено')) return job.notice;
  if (job.phase === 'done') return job.summary?.failed || job.summary?.directoriesFailed ? 'завершено с ошибками' : 'готово';
  return job.phase === 'ready' ? 'готово к скачиванию' : 'пауза';
}

export function shortSessionTitle(value = '') { const chars = Array.from(value); return chars.length > 10 ? chars.slice(0, 10).join('') + '…' : value; }
