import { waitFor } from './wait.js';

const COOLDOWNS = [60000, 120000, 300000, 600000, 1800000];
// One gate for every VK session and both media types. Yandex never enters it.
// Existing transfers can finish; a 429 stops new attempts, including 404 retries.
export function createVkRateLimit({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), trace = () => {} } = {}) {
  let epoch = 0, blocked = false, until = 0, probe = false, strikes = 0, nextStart = 0, limited = false;
  function status() {
    if (!blocked) return '';
    if (probe) return 'ВК: проверяем доступность файлов после HTTP 429';
    return 'ВК ограничил скачивание (HTTP 429) · общая пауза ' + Math.max(0, Math.ceil((until - now()) / 1000)) + ' с';
  }
  const waiting = () => blocked ? probe || now() < until : now() < nextStart;
  function rejectRate(error, ticket) {
    const serverDelay = Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : 0;
    // Replies already in flight belong to the same wave, not separate failures.
    if (ticket.epoch === epoch) {
      epoch++; strikes++; blocked = true; probe = false; limited = true;
      until = now() + Math.max(COOLDOWNS[Math.min(strikes - 1, COOLDOWNS.length - 1)], serverDelay);
      trace('vk.rate.limit', { status: 429, attempt: strikes, ms: until - now(), retryAfterMs: serverDelay });
    } else if (blocked) until = Math.max(until, now() + serverDelay);
  }
  function finishProbe(ticket, error) {
    if (!ticket.probe || ticket.epoch !== epoch) return;
    probe = false;
    if (!error || (error.fileServer && error.status !== 429)) {
      blocked = false; nextStart = now() + 1000;
      trace('vk.rate.recovered', { status: error?.status || 200, attempt: strikes });
    } else {
      // Cancellation/network failures do not establish that the server recovered.
      until = Math.max(until, now() + (error?.name === 'AbortError' ? 1000 : 60000));
      trace('vk.rate.probe.error', { status: error?.status || 0, ms: until - now() });
    }
  }
  async function run(work, { signal, wait = work => work(), onStatus = () => {} } = {}) {
    for (;;) {
      signal?.throwIfAborted();
      if (waiting()) {
        await wait(async () => {
          while (waiting()) {
            signal?.throwIfAborted();
            onStatus(status() || 'ВК: плавное возобновление скачивания');
            await waitFor(sleep(500), { signal, timeout: null });
          }
        });
        // The pool may take time to return a slot. Recheck after acquiring it.
        continue;
      }
      signal?.throwIfAborted();
      const ticket = { epoch, probe: blocked };
      if (ticket.probe) { probe = true; onStatus(status()); trace('vk.rate.probe', { attempt: strikes }); }
      if (limited) nextStart = now() + 1000;
      try {
        const value = await work();
        finishProbe(ticket); return value;
      } catch (error) {
        if (error.fileServer && error.status === 429 && !signal?.aborted) {
          rejectRate(error, ticket);
          continue;
        }
        finishProbe(ticket, error); throw error;
      }
    }
  }
  return { run, status };
}
