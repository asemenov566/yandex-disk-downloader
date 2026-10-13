// Bound browser API promises too: they may remain pending before the download ID
// is returned. A late ID still needs cleanup after timeout or user cancellation.
export function waitFor(promise, { signal, timeout = 10000, message = 'Chrome не ответил за 10 секунд.', onLateValue } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (fn, value) => {
      if (settled) return false;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      fn(value); return true;
    };
    const abort = () => finish(reject, signal.reason || new DOMException('Отменено', 'AbortError'));
    Promise.resolve(promise).then(value => {
      if (!finish(resolve, value) && onLateValue) Promise.resolve().then(() => onLateValue(value)).catch(() => {});
    }, error => finish(reject, error));
    if (Number.isFinite(timeout)) timer = setTimeout(() => finish(reject, new Error(message)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
