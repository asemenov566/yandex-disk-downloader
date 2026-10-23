import { waitFor } from './wait.js';

export const NOT_FOUND_DELAYS = [1000, 3000, 6000, 12000, 24000, 48000];
// VK can lend its slot during retry delays, within a bounded waiting budget.
// this budget is separate from the user's whole-session completion repeats.
export async function retryNotFound(work, { signal, timeout, sleep, onStatus = () => {}, onAttempt = () => {}, onError = () => {}, onSuccess = () => {}, wait = work => work() }) {
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
      if (!retryable || attempt >= NOT_FOUND_DELAYS.length) throw error;
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
