export function overallProgress(jobs) {
  const result = { jobs: jobs.length, active: 0, scanning: 0, pages: 0,
    total: 0, done: 0, skipped: 0, failed: 0, directoriesFailed: 0, reused: 0, originals: 0, previews: 0, newFiles: 0 };
  for (const job of jobs) {
    if (job.running) result.active++;
    if (job.running && job.phase === 'scanning') result.scanning++;
    result.pages += job.pages || 0;
    const counts = job.summary || job;
    for (const key of ['total', 'done', 'skipped', 'failed', 'directoriesFailed', 'reused', 'originals', 'previews']) {
      result[key] += counts[key] || 0;
    }
    result.newFiles += job.overallNewFiles ?? counts.newFiles ?? 0;
  }
  // Count files, not an average of album percentages. Failed directories have
  // no known file count and must not inflate the progress numerator.
  result.processed = result.done + result.skipped + result.failed;
  result.percent = result.total ? Math.min(100, Math.floor(result.processed / result.total * 100)) : 0;
  result.visible = result.jobs > 1;
  return result;
}
