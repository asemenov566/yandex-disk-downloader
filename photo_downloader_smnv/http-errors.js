// Keep only safe diagnostics; signed URLs and response bodies must not enter logs.
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  value = value.trim();
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isSafeInteger(seconds) && Number.isSafeInteger(seconds * 1000)) return seconds * 1000;
  if (!/^[A-Za-z]{3},/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export function fileHttpError(response) {
  const error = Object.assign(new Error('Файловый сервер: HTTP ' + response.status), { status: response.status, fileServer: true });
  const delay = retryAfterMs(response.headers?.get('retry-after'));
  if (delay !== undefined) error.retryAfterMs = delay;
  return error;
}
