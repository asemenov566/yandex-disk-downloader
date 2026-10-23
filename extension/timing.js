export function activeTime(intervals = []) {
  if (!Array.isArray(intervals)) return 0;
  const ranges = intervals.filter(range => Array.isArray(range) && range.length === 2 &&
    range.every(Number.isFinite) && range[1] >= range[0]).map(range => [...range]).sort((a, b) => a[0] - b[0]);
  let total = 0, start, end;
  for (const range of ranges) {
    if (end == null) [start, end] = range;
    else if (range[0] <= end) end = Math.max(end, range[1]);
    else { total += end - start; [start, end] = range; }
  }
  return total + (end == null ? 0 : end - start);
}

export function jobTiming(job, counts, pendingDirectories) {
  const intervals = job.timeIntervals || [];
  const elapsedMs = activeTime(intervals), partial = pendingDirectories > 0;
  const samples = Number.isSafeInteger(job.timingFiles) ? job.timingFiles : 0;
  const previousRate = Number.isFinite(job.previousMsPerFile) && job.previousMsPerFile > 0 ? job.previousMsPerFile : null;
  const rate = samples >= 2 && elapsedMs >= 1000 ? elapsedMs / samples : previousRate;
  const remainingMs = !counts.pending ? (partial ? null : 0) : rate ? Math.round(rate * counts.pending) : null;
  return { elapsedMs, remainingMs, partial, intervals };
}

export function overallTiming(jobs) {
  const elapsedMs = activeTime(jobs.flatMap(job => job.timing?.intervals || []));
  const working = jobs.filter(job => job.running || job.queued);
  const waiting = jobs.some(job => !job.running && (job.resumable || job.queued));
  const partial = waiting || jobs.some(job => job.timing?.partial);
  const remainingMs = !working.length ? (waiting ? null : 0) :
    working.some(job => job.timing?.remainingMs == null) ? null : Math.max(...working.map(job => job.timing.remainingMs));
  return { elapsedMs, remainingMs, partial, waiting };
}

export function duration(ms) {
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  return [hours ? `${hours} ч` : '', minutes || hours ? `${minutes} мин` : '', `${seconds} с`].filter(Boolean).join(' ');
}

export function timingText(timing, running) {
  if (!timing) return '';
  const elapsed = `Время работы: ${duration(timing.elapsedMs)}`;
  if (!running) return elapsed + (timing.remainingMs === 0 ? '' : ' · пауза');
  if (timing.remainingMs == null) return elapsed + (timing.partial ? ' · полный список ещё неизвестен' : ' · время остатка пока неизвестно: нет статистики скорости');
  const estimate = duration(Math.ceil(timing.remainingMs / 1000) * 1000);
  return elapsed + (timing.partial ? ` · на найденные файлы ≈ ${estimate}` : ` · осталось ≈ ${estimate}`);
}

export function remainingText(job) {
  const s = job.summary || {};
  const pending = s.pending ?? Math.max(0, (s.total || job.total || 0) - (s.done || job.done || 0) - (s.skipped || 0) - (s.failed || 0));
  return 'Осталось файлов: ' + (pending + (s.failed || 0)) + ' · из них ошибок: ' + (s.failed || 0) +
    (s.directoriesFailed ? ' · ошибок списка: ' + s.directoriesFailed : '') +
    (job.pendingDirectories ? ' · список дополняется' : '');
}
