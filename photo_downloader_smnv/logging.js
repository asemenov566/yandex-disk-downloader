import { deadline } from './deadlines.js';

// Only explicitly selected diagnostic fields are accepted. Never log request
// bodies, credentials, URLs, browser errors, messages or attachment contents.
const fields = new Set(['jobId','session','provider','file','kind','stage','phase','action','requestId','queueDepth','ms','attempt','status','reason','cmid','position','page','files','total','done','failed','pending','active','photos','videos','limit','bytes','unchangedMs','running','recovering','tabId','enabled','count','downloadLimit','vkDownloadLimit','timeoutSeconds','host','changed','linkAgeMs','vkPageDelaySeconds','retryAfterMs','width','height']);
function clean(data) {
  return Object.fromEntries(Object.entries(data).filter(([key, value]) => fields.has(key) &&
    (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))))
    .map(([key, value]) => [key, typeof value === 'string' ? value.replace(/https?:[^\s]+/gi, '[URL]').replace(/vk1\.[^\s]+/g, '[TOKEN]').slice(0, 160) : value]));
}
export function errorInfo(error) {
  return { ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}), status: Number(error?.status) || 0, reason: error?.name === 'AbortError' ? 'cancelled' : error?.localAccess ? 'folder-access' :
    error?.vkSession ? 'vk-session' : error?.retryable ? 'retryable' : /не ответил|Нет данных|timeout|timed out/i.test(error?.message || '') ? 'timeout' : 'failure' };
}
export function logFileName(at = Date.now()) {
  const date = new Date(at), pad = n => String(n).padStart(2, '0');
  return 'log--' + pad(date.getDate()) + '-' + pad(date.getMonth() + 1) + '-' + date.getFullYear() + '.log';
}
export function createDiagnosticLog({ append = async () => {}, read = async () => '', clear = async () => {}, now = Date.now,
  schedule = deadline, maxEntries = 20000 } = {}) {
  let enabled = false, entries = [], dropped = 0, sequence = 0, timer, writing = Promise.resolve(), storageError = false;
  const ready = Promise.resolve();
  function plan() {
    if (!timer && entries.length) timer = schedule(() => { timer = null; void flush(); }, 5000);
  }
  function flush() {
    timer?.(); timer = null;
    writing = writing.catch(() => {}).then(async () => {
      const batch = entries.splice(0);
      if (!batch.length) return;
      try { await append(batch); storageError = false; }
      catch {
        storageError = true; entries = [...batch, ...entries];
        if (entries.length > maxEntries) { dropped += entries.length - maxEntries; entries = entries.slice(-maxEntries); }
      }
      plan();
    });
    return writing;
  }
  function record(event, data = {}) {
    if (!enabled) return;
    entries.push({ seq: ++sequence, at: new Date(now()).toISOString(), event, ...clean(data) });
    if (entries.length > maxEntries) { dropped += entries.length - maxEntries; entries.splice(0, entries.length - maxEntries); }
    plan();
  }
  return {
    ready, record, flush,
    status: () => ({ logging: enabled, logCount: sequence, logError: storageError,
      logFile: 'photo_downloader_smnv/' + logFileName(now()), logPending: entries.length, logDropped: dropped }),
    async setEnabled(value) {
      if (enabled === value) return;
      if (enabled) record('logging.disabled');
      enabled = value;
      if (enabled) record('logging.enabled');
      await flush();
    },
    async export() { await flush(); return read(logFileName(now())); },
    async clear() {
      await flush();
      // Do not discard buffered events if writing or clearing the disk file failed.
      if (storageError) throw new Error('Журнал ещё не записан: подтвердите доступ к папке.');
      const name = logFileName(now());
      writing = writing.then(() => clear(name));
      await writing;
      sequence = 0; dropped = 0;
      record('logging.cleared'); await flush();
    }
  };
}
let logger = createDiagnosticLog();
export function configureLogging(options) { logger = createDiagnosticLog(options); }
export const trace = (event, fields) => logger.record(event, fields);
export const setLogging = enabled => logger.setEnabled(enabled);
export const logStatus = () => logger.status();
export const exportLog = () => logger.export();
export const clearLog = () => logger.clear();
