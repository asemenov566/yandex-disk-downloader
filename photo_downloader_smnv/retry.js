import { waitFor } from './wait.js';

export const NOT_FOUND_DELAYS = [1000, 7000, 14000];
// VK can lend its slot during retry delays, within a bounded waiting budget.
// this budget is separate from the user's whole-session completion repeats.
export async function retryNotFound(work, { signal, timeout, sleep, onStatus = () => {}, onAttempt = () => {}, onError = () => {}, onSuccess = () => {}, canRetry = () => true, onExhausted = () => {}, wait = work => work() }) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const limit = attempt ? NOT_FOUND_DELAYS[attempt - 1] : timeout, started = Date.now();
    onAttempt(attempt, limit);
    try { const value = await work(limit, attempt); onSuccess(attempt, Date.now() - started); return value; }
    catch (error) {
      onError(error, attempt, Date.now() - started);
      signal?.throwIfAborted();
      // Once a 404 chain has started, a short transfer timeout must not
      // prevent the later attempts from reaching their larger data budgets.
      const retryable = error.status === 404 || (attempt > 0 && error.dataTimeout === true);
      if (!retryable || !canRetry(error, attempt)) throw error;
      if (attempt >= NOT_FOUND_DELAYS.length) { onExhausted(error); throw error; }
      const delay = NOT_FOUND_DELAYS[attempt];
      await wait(async () => {
      for (let left = delay; left > 0; left -= 500) {
        onStatus((error.dataTimeout ? 'Нет данных' : 'HTTP 404') + ' · повтор ' + (attempt + 1) + '/' + NOT_FOUND_DELAYS.length + ' через ' + Math.ceil(left / 1000) + ' с');
        await waitFor(sleep(Math.min(left, 500)), { signal });
      }
      });
      onStatus('Повтор ' + (attempt + 1) + '/' + NOT_FOUND_DELAYS.length + ' · ожидание данных до ' + delay / 1000 + ' с');
    }
  }
}

// Recently exhausted URLs still receive one real probe on every pass. Only the
// long 404 chain is suppressed; changed URLs, success and expiry restore it.
// File identity scopes this cache to a job. It is never persisted or logged.
export const NOT_FOUND_COOLDOWN = 10 * 60 * 1000;
export function createNotFoundPolicy({ now = Date.now, cooldown = NOT_FOUND_COOLDOWN } = {}) {
  const exhausted = new WeakMap();
  return (file, getUrl, onSkip = () => {}) => {
    const initialUrl = getUrl();
    const records = exhausted.get(file) || new Map();
    for (const [url, at] of records) if (now() - at >= cooldown || now() < at) records.delete(url);
    exhausted.set(file, records);
    return {
      canRetry(error) {
        const url = getUrl(), at = records.get(url);
        if (error.status !== 404 || at === undefined || now() - at >= cooldown || now() < at) return true;
        onSkip(); return false;
      },
      onExhausted(error) {
        const url = getUrl();
        // Do not mark a newly refreshed URL after just one failed request.
        if (error.status === 404 && url && url === initialUrl) {
          if (!records.has(url) && records.size >= 3) records.delete(records.keys().next().value);
          records.set(url, now());
        }
      },
      recovered() { records.delete(getUrl()); }
    };
  };
}
