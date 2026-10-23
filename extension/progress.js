import { overallTiming } from './timing.js';
export function overallProgress(jobs) {
  const result = { jobs: jobs.length, active: 0, scanning: 0, pages: 0,
    total: 0, done: 0, skipped: 0, failed: 0, directoriesFailed: 0, reused: 0, originals: 0, previews: 0, newFiles: 0 };
  for (const job of jobs) {
    if (job.running) result.active++;
    if (job.running && (job.phase === 'scanning' || job.pendingDirectories > 0)) result.scanning++;
    result.pages += job.pages || 0;
    const counts = job.summary || job;
    for (const key of ['total', 'done', 'skipped', 'failed', 'directoriesFailed', 'reused', 'originals', 'previews']) {
      result[key] += counts[key] || 0;
    }
    result.newFiles += job.overallNewFiles ?? counts.newFiles ?? 0;
  }
  // Count files, not an average of album percentages. Failed directories have
  // no known file count and must not inflate the progress numerator.
  result.processed = result.done + result.skipped;
  result.percent = result.total ? Math.min(jobs.some(job => job.pendingDirectories > 0) ? 99 : 100, Math.floor(result.processed / result.total * 100)) : 0;
  result.timing = overallTiming(jobs);
  result.visible = result.jobs > 0;
  return result;
}

export function jobProgress(job) {
  const counts = job.summary || job;
  return counts.total ? Math.min(job.pendingDirectories > 0 ? 99 : 100, Math.floor(((counts.done || 0) + (counts.skipped || 0)) / counts.total * 100)) : 0;
}

export function sortedSessions(jobs) {
  const rank = job => job.paused ? 0 : job.running || job.queued ? 1 : job.completed || job.phase === 'done' ? 2 : 0;
  return [...jobs].sort((a, b) => rank(a) - rank(b));
}
