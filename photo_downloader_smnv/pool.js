import { waitFor } from './wait.js';
export const DOWNLOAD_LIMITS = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 70, 100, 150, 200];
export const VK_DOWNLOAD_PRESETS = [
  { value: 1, photos: 1, videos: 1, label: '1' },
  { value: 5, photos: 4, videos: 1, label: '4+1' },
  { value: 10, photos: 8, videos: 2, label: '8+2' },
  { value: 16, photos: 12, videos: 4, label: '12+4' },
  { value: 30, photos: 20, videos: 10, label: '20+10' },
  { value: 40, photos: 25, videos: 15, label: '25+15' },
  { value: 80, photos: 50, videos: 30, label: '50+30' },
  { value: 110, photos: 70, videos: 40, label: '70+40' },
  { value: 150, photos: 100, videos: 50, label: '100+50' },
  { value: 220, photos: 150, videos: 70, label: '150+70' },
  { value: 300, photos: 200, videos: 100, label: '200+100' }
];
export const VK_DOWNLOAD_LIMITS = VK_DOWNLOAD_PRESETS.map(preset => preset.value);
export const createVkDownloadPool = (limit = 1) => createDownloadPool(limit, VK_DOWNLOAD_PRESETS);

// An adjustable budget for files in one job. Items are pulled
// lazily: a large album doesn't allocate a promise/listener for every photo.
export function createDownloadPool(initialLimit = 1, presets = null) {
  let limit = initialLimit, active = 0;
  const activeKinds = { photos: 0, videos: 0 }, waitingKinds = { photos: 0, videos: 0 };
  let waiting = 0;
  const resumptions = [];
  const kindLimit = kind => presets ? presets.find(preset => preset.value === limit)[kind] : limit;
  const kindOf = item => item?.kind === 'video' ? 'videos' : 'photos';
  const canStart = group => {
    if (group.error || group.index >= group.items.length) return false;
    const kind = kindOf(group.items[group.index]);
    return !presets || (activeKinds[kind] < kindLimit(kind) && active + waiting < 2 * limit &&
      activeKinds[kind] + waitingKinds[kind] < 2 * kindLimit(kind));
  };
  const groups = [];
  function finish(group) {
    if (group.running || (!group.error && group.index < group.items.length)) return;
    const index = groups.indexOf(group);
    if (index < 0) return;
    groups.splice(index, 1);
    group.signal?.removeEventListener('abort', group.abort);
    if (group.error) group.reject(group.error); else group.resolve();
  }
  function pump() {
    for (const group of [...groups]) finish(group);
    while (active < limit) {
      // A due retry gets its slot back before a new file of the same kind.
      const resumeIndex = resumptions.findIndex(item => activeKinds[item.kind] < kindLimit(item.kind));
      if (resumeIndex >= 0) {
        const item = resumptions.splice(resumeIndex, 1)[0];
        item.acquire(); continue;
      }
      const group = groups.find(canStart);
      if (!group) break;
      groups.splice(groups.indexOf(group), 1); groups.push(group);
      const item = group.items[group.index++], kind = kindOf(item);
      let held = true;
      const release = () => { if (held) { held = false; active--; activeKinds[kind]--; } };
      active++; group.running++; activeKinds[kind]++;
      const lease = {
        async wait(work, onResume = () => {}, onSuspend = () => {}) {
          // Yandex retains its old accounting. VK always lends a waiting slot;
          // admission bounds all live work (transferring + waiting) to 2x caps.
          if (!presets) return work();
          waiting++; waitingKinds[kind]++; release(); onSuspend(); pump();
          let result, failure;
          try { result = await waitFor(Promise.resolve().then(work), { signal: group.signal, timeout: null }); }
          catch (error) { failure = error; }
          try {
            group.signal?.throwIfAborted();
            if (group.error) throw group.error;
            onResume();
            await new Promise((resolve, reject) => {
              const resume = { kind, acquire() {
                group.signal?.removeEventListener('abort', abort);
                held = true; active++; activeKinds[kind]++; resolve();
              } };
              const abort = () => {
                const index = resumptions.indexOf(resume);
                if (index >= 0) resumptions.splice(index, 1);
                group.signal?.removeEventListener('abort', abort); reject(group.signal.reason);
              };
              group.signal?.addEventListener('abort', abort, { once: true });
              resumptions.push(resume); pump();
            });
            if (failure) throw failure;
            return result;
          } finally { waiting--; waitingKinds[kind]--; pump(); }
        }
      };
      Promise.resolve().then(() => { group.signal?.throwIfAborted(); return group.work(item, lease); })
        .catch(error => { group.error ||= error; })
        .finally(() => { release(); group.running--; finish(group); pump(); });
    }
  }

  return {
    get limit() { return limit; },
    get active() { return active; },
    get waiting() { return waiting; },
    setLimit(value) {
      if (!(presets ? presets.map(preset => preset.value) : DOWNLOAD_LIMITS).includes(value)) throw new Error('Недопустимый лимит скачивания.');
      limit = value; pump();
    },
    run(items, work, signal) {
      return new Promise((resolve, reject) => {
        const group = { items, work, signal, resolve, reject, index: 0, running: 0, error: null };
        group.abort = () => { group.error ||= signal.reason || new DOMException('Пауза', 'AbortError'); pump(); };
        groups.push(group);
        signal?.addEventListener('abort', group.abort, { once: true });
        if (signal?.aborted) group.abort(); else pump();
      });
    }
  };
}
