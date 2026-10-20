export const DOWNLOAD_LIMITS = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

// One shared, adjustable budget for files across all albums. Items are pulled
// lazily: a large album doesn't allocate a promise/listener for every photo.
export function createDownloadPool(initialLimit = 1) {
  let limit = initialLimit, active = 0;
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
      const group = groups.find(g => !g.error && g.index < g.items.length);
      if (!group) break;
      // Rotate albums so none can monopolize the next available slot.
      groups.splice(groups.indexOf(group), 1); groups.push(group);
      const item = group.items[group.index++];
      active++; group.running++;
      Promise.resolve().then(() => { group.signal?.throwIfAborted(); return group.work(item); })
        .catch(error => { group.error ||= error; })
        .finally(() => { active--; group.running--; finish(group); pump(); });
    }
  }
  return {
    get limit() { return limit; },
    get active() { return active; },
    setLimit(value) {
      if (!DOWNLOAD_LIMITS.includes(value)) throw new Error('Выберите число загрузок: 1 или от 5 до 50 с шагом 5.');
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
