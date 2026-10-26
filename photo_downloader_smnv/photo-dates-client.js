// The WASM library has shared state. One worker and one operation at a time
// keep it off the UI thread and bound its memory even with 200 downloads.
export function createPhotoDatesProcessor() {
  let worker, processed = 0, serial = Promise.resolve();
  return (blob, fallback, signal) => {
    const work = serial.catch(() => {}).then(() => new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      worker ||= new Worker(new URL('./photo-dates-worker.js', import.meta.url), { type: 'module' });
      const current = worker;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); current.onmessage = null; current.onerror = null; };
      const fail = error => { cleanup(); current.terminate(); worker = null; processed = 0; reject(error); };
      const abort = () => fail(signal.reason || new DOMException('Остановлено', 'AbortError'));
      const timer = setTimeout(() => fail(new Error('Обработка дат фотографии не завершилась за 2 минуты.')), 120000);
      signal?.addEventListener('abort', abort, { once: true });
      current.onerror = () => fail(new Error('Не удалось запустить обработку дат в браузере.'));
      current.onmessage = ({ data }) => {
        cleanup();
        // Reclaim the WASM high-water allocation during long sessions.
        if (++processed >= 20) { current.terminate(); worker = null; processed = 0; }
        data.ok ? resolve(data.value) : reject(new Error(data.error));
      };
      current.postMessage({ blob, fallback });
    }));
    serial = work; return work;
  };
}
