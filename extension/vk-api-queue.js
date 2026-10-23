// One paced API lane. Three discovery requests alternate with one refresh;
// within each class, dialogs take turns. Refresh admission is bounded.
export function createVkApiQueue({ refreshLimit = 16 } = {}) {
  const ready = [], admission = [];
  let active = false, refreshCount = 0, discoveryRun = 0;
  const turns = { discovery: new Map(), refresh: new Map(), admission: new Map() };
  let turn = 0;
  function take(list, category) {
    let index = 0;
    for (let i = 1; i < list.length; i++) {
      if ((turns[category].get(list[i].key) || 0) < (turns[category].get(list[index].key) || 0)) index = i;
    }
    const item = list.splice(index, 1)[0];
    turns[category].set(item.key, ++turn);
    return item;
  }
  function admit() {
    while (refreshCount < refreshLimit && admission.length) {
      const item = take(admission, 'admission');
      item.admitted = true; refreshCount++; ready.push(item); item.onAdmitted();
    }
  }
  function pump() {
    if (active) return;
    active = true;
    void Promise.resolve().then(async () => {
      while (ready.length) {
        const discovery = ready.filter(item => !item.refresh), refresh = ready.filter(item => item.refresh);
        const useRefresh = refresh.length && (!discovery.length || discoveryRun >= 3);
        const category = useRefresh ? 'refresh' : 'discovery';
        const item = take(useRefresh ? refresh : discovery, category);
        ready.splice(ready.indexOf(item), 1); item.started = true;
        discoveryRun = useRefresh ? 0 : discoveryRun + 1;
        try { item.signal?.throwIfAborted(); item.resolve(await item.work()); }
        catch (error) { item.reject(error); }
        finally {
          item.signal?.removeEventListener('abort', item.abort);
          if (item.refresh) refreshCount--;
          admit();
        }
      }
    }).finally(() => { active = false; if (ready.length) pump(); });
  }
  return {
    get depth() { return ready.length; },
    get waiting() { return admission.length; },
    run(work, { key, refresh = false, signal, onAdmitted = () => {}, onWaiting = () => {} }) {
      return new Promise((resolve, reject) => {
        const item = { key, refresh, work, signal, resolve, reject, onAdmitted, started: false, admitted: false };
        item.abort = () => {
          if (item.started) return; // The running request owns cancellation.
          for (const list of [ready, admission]) { const index = list.indexOf(item); if (index >= 0) list.splice(index, 1); }
          if (item.admitted && refresh) refreshCount--;
          signal?.removeEventListener('abort', item.abort);
          reject(signal.reason); admit(); pump();
        };
        if (signal?.aborted) { reject(signal.reason); return; }
        signal?.addEventListener('abort', item.abort, { once: true });
        if (refresh) { admission.push(item); onWaiting(); admit(); }
        else { item.admitted = true; ready.push(item); onAdmitted(); }
        pump();
      });
    }
  };
}
