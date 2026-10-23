export const DOWNLOAD_MODES = ['auto', 'original', 'photos-auto', 'photos-original', 'videos'];
// preview is kept only for compatibility with old programmatic callers.
export const STORED_MODES = [...DOWNLOAD_MODES, 'preview'];
export const mediaTypeForMode = mode => mode === 'videos' ? 'videos' : mode.startsWith('photos-') ? 'photos' : 'all';
export const photoQualityForMode = mode => mode === 'photos-auto' ? 'auto' : mode === 'photos-original' || mode === 'videos' ? 'original' : mode;

export function migrateDownloadMode(job) {
  if (job.modeVersion === 1) return;
  // The user explicitly wants every pre-update job to use the new default,
  // regardless of its previous quality choice. Keep files and cursors intact.
  job.mode = 'auto'; job.modeVersion = 1;
  job.usePreviews = false; job.originalFailures = 0;
}
