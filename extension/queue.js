import { createRunner } from './runner.js';
import { newJob, parseLink, reportAll } from './core.js';
import { waitFor } from './wait.js';
import { createDownloadPool, DOWNLOAD_LIMITS } from './pool.js';
import { DOWNLOAD_TIMEOUTS, DEFAULT_TIMEOUT_SECONDS } from './settings.js';

export function createQueue({ loadEntries, saveEntry, deleteEntry = async () => {}, concurrency = Infinity,
  loadSettings = async () => ({}), saveSettings = async () => {}, onActivityChange = () => {},
  prepareDownloads = async () => {}, changeFolder = async () => {}, ...dependencies }) {
  const entries = [], runners = new Map(), active = new Set();
  const pool = createDownloadPool();
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  const completions = new Map();
  const activity = () => onActivityChange(active.size > 0 || entries.some(e => e.wanted));
  const locks = new Map();
  async function withFileLock(key, work, signal) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const lock = new Promise(resolve => { release = resolve; });
    locks.set(key, lock);
    let acquired = false;
    const unlock = () => { release(); if (locks.get(key) === lock) locks.delete(key); };
    try {
      await waitFor(previous, { signal, timeout: null }); acquired = true;
      return await work();
    } finally {
      // An aborted waiter returns immediately, but its successors must still
      // wait for the original owner before entering the critical section.
      if (acquired) unlock(); else previous.then(unlock, unlock);
    }
  }
  let serial = Promise.resolve(), scheduling = Promise.resolve();
  const runnerFor = entry => {
    if (!runners.has(entry.id)) runners.set(entry.id, createRunner({ ...dependencies, withFileLock, runFiles: pool.run,
      getTimeout: () => timeoutSeconds * 1000,
      loadJob: async () => entry.job,
      saveJob: async job => { entry.job = job; await saveEntry(entry); }
    }));
    return runners.get(entry.id);
  };
  async function restore(restored, settings) {
    entries.length = 0; runners.clear();
    pool.setLimit(DOWNLOAD_LIMITS.includes(settings?.downloadLimit) ? settings.downloadLimit : 1);
    timeoutSeconds = DOWNLOAD_TIMEOUTS.includes(settings?.timeoutSeconds) ? settings.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
    restored.sort((a, b) => a.job.created.localeCompare(b.job.created));
    for (const entry of restored) {
      entry.wanted = false; entries.push(entry);
      await runnerFor(entry).ready;
    }
    // Recover receipts from every old job before removing duplicate UI records.
    for (const entry of [...entries]) {
      const newer = entries.findLast(e => e.job.publicUrl === entry.job.publicUrl && e.job.path === entry.job.path);
      if (newer !== entry) {
        entries.splice(entries.indexOf(entry), 1); runners.delete(entry.id); await deleteEntry(entry.id);
      }
    }
  }
  const ready = (async () => restore(await loadEntries(), await loadSettings()))();
  function overlaps(a, b) {
    if (a.publicUrl !== b.publicUrl) return false;
    const x = a.path.replace(/\/+$/, '') + '/', y = b.path.replace(/\/+$/, '') + '/';
    return x.startsWith(y) || y.startsWith(x);
  }
  function rememberQueuedRetry(entry) {
    if (entry.wanted && !active.has(entry.id) && entry.action === 'retry') {
      entry.suspendedRetry = { ...entry.actionArgs };
    }
  }
  function kick() {
    scheduling = scheduling.catch(() => {}).then(async () => {
      for (const entry of entries) {
        if (active.size >= concurrency) break;
        if (!entry.wanted || active.has(entry.id)) continue;
        if (entries.some(other => active.has(other.id) && overlaps(entry.job, other.job))) continue;
        const runner = runnerFor(entry);
        active.add(entry.id);
        activity();
        try { await runner.command(entry.action || 'start', entry.actionArgs || {}); }
        catch (error) { active.delete(entry.id); entry.wanted = false; entry.error = error.message; await saveEntry(entry); continue; }
        const completion = runner.waitUntilIdle().then(async () => {
          active.delete(entry.id); entry.wanted = false; await saveEntry(entry); await kick();
        }).catch(error => { active.delete(entry.id); entry.wanted = false; entry.error = error.message; })
          .finally(() => { completions.delete(entry.id); activity(); });
        completions.set(entry.id, completion);
      }
      activity();
    });
    return scheduling;
  }
  async function snapshot(id, link, allIssues = false) {
    let selected = entries.find(e => e.id === id);
    if (!selected && link) {
      try {
        const target = parseLink(link);
        selected = entries.findLast(e => e.job.publicUrl === target.publicUrl && e.job.path === target.path);
      } catch { /* Active tab need not be a public Yandex link. */ }
    }
    selected ||= entries.at(-1);
    const states = await Promise.all(entries.map(async entry => {
      const state = await runnerFor(entry).command('status', { allIssues });
      return { entry, state };
    }));
    const chosen = states.find(s => s.entry === selected);
    return { ...(chosen?.state || { running: false, job: null, current: '', notice: '' }),
      downloadLimit: pool.limit, timeoutSeconds, activeDownloads: pool.active,
      id: selected?.id, queued: !!selected?.wanted && !active.has(selected.id),
      notice: selected?.error || chosen?.state.notice || '',
      jobs: states.map(({ entry, state }) => ({ id: entry.id,
        title: state.job?.title || entry.job.path, running: state.running,
        queued: entry.wanted && !active.has(entry.id), phase: state.job.phase,
        done: state.job.summary.done, total: state.job.summary.total,
        summary: state.job.summary, pages: state.job.pages, current: state.current,
        resumable: !entry.wanted && !active.has(entry.id) && !state.running &&
          (state.job.summary.pending > 0 || state.job.pendingDirectories > 0 || !!entry.suspendedRetry),
        completed: !entry.wanted && !active.has(entry.id) && !state.running && state.job.phase === 'done',
        issuesTotal: state.job.issuesTotal, ...(allIssues ? { issues: state.job.issues } : {}),
        publicUrl: entry.job.publicUrl, path: entry.job.path }))
    };
  }
  async function execute(action, args = {}) {
    await ready;
    if (action === 'status') return snapshot(args.id, args.link, args.allIssues);
    if (['scan', 'start', 'retry'].includes(action)) await prepareDownloads();
    if (action === 'stopAll' || action === 'pauseAll') {
      await scheduling;
      const targets = entries.filter(e => e.wanted || active.has(e.id));
      // Clear all queued starts before aborting a worker: its completion may
      // immediately schedule the next album otherwise.
      for (const entry of targets) { rememberQueuedRetry(entry); entry.wanted = false; }
      await Promise.all(targets.map(e => runnerFor(e).command(action === 'pauseAll' ? 'pause' : 'stop')));
      await Promise.all(targets.map(e => runnerFor(e).waitUntilIdle()));
      await Promise.all([...completions.values()]);
      await Promise.all(targets.map(e => saveEntry(e)));
      activity();
      return snapshot(args.id, undefined, args.allIssues);
    }
    if (action === 'reportAll') {
      if (active.size || entries.some(e => e.wanted)) throw new Error('Приостановите все задания перед созданием отчёта.');
      if (!entries.length) throw new Error('Нет заданий для отчёта.');
      await prepareDownloads();
      const blob = new Blob([reportAll(entries.map(e => e.job))], { type: 'text/csv;charset=utf-8' });
      const path = `yandex-disk/download-report-all-${Date.now()}-${crypto.randomUUID()}.csv`;
      await dependencies.saveLocal(path, blob, { expectedSize: blob.size });
      const state = await snapshot(args.id, undefined, args.allIssues);
      return { ...state, notice: 'Общий отчёт сохранён: ' + path };
    }
    if (action === 'resumeAll') {
      const resumable = (await snapshot()).jobs.filter(j => j.resumable);
      if (resumable.length) await prepareDownloads();
      for (const item of resumable) {
        const entry = entries.find(e => e.id === item.id);
        entry.wanted = true; entry.action = entry.suspendedRetry ? 'retry' : 'start';
        entry.actionArgs = { ...entry.suspendedRetry, resumeStopped: true }; delete entry.suspendedRetry;
        delete entry.error;
        await saveEntry(entry);
      }
      await kick();
      return snapshot(args.id, undefined, args.allIssues);
    }
    if (action === 'downloadAll' || action === 'retryAll') {
      const targets = (await snapshot()).jobs.filter(item => item.completed &&
        (action === 'downloadAll' || item.summary.failed || item.summary.directoriesFailed ||
          (args.includePreviews === true && item.summary.previews)));
      if (targets.length) await prepareDownloads();
      for (const item of targets) {
        const entry = entries.find(e => e.id === item.id);
        if (action === 'downloadAll') {
          const previous = entry.job;
          entry.job = newJob(previous.publicUrl + (previous.path === '/' ? '' : previous.path), previous.mode,
            { deduplicate: previous.deduplicate });
          runners.delete(entry.id);
          entry.action = 'start'; entry.actionArgs = {};
        } else {
          entry.action = 'retry'; entry.actionArgs = { includePreviews: args.includePreviews === true };
        }
        delete entry.error; delete entry.suspendedRetry;
        entry.wanted = true;
        await saveEntry(entry); await runnerFor(entry).ready;
      }
      await kick();
      return snapshot(args.id, undefined, args.allIssues);
    }
    if (action === 'settings') {
      const limit = args.downloadLimit === undefined ? pool.limit : args.downloadLimit;
      const timeout = args.timeoutSeconds === undefined ? timeoutSeconds : args.timeoutSeconds;
      if (!DOWNLOAD_LIMITS.includes(limit)) throw new Error('Недопустимое число загрузок.');
      if (!DOWNLOAD_TIMEOUTS.includes(timeout)) throw new Error('Недопустимое время ожидания.');
      await saveSettings({ downloadLimit: limit, timeoutSeconds: timeout });
      pool.setLimit(limit); timeoutSeconds = timeout;
      return snapshot(args.id, undefined, args.allIssues);
    }
    if (action === 'folder') {
      if (active.size || entries.some(e => e.wanted)) throw new Error('Сначала приостановите все задания, затем измените папку.');
      const restored = await changeFolder(args.token);
      if (restored) await restore(restored.entries, restored.settings);
      return snapshot(args.id, undefined, args.allIssues);
    }
    if (action === 'scan') {
      const job = newJob(args.link, args.mode, { deduplicate: args.deduplicate });
      let entry = entries.find(e => (e.wanted || active.has(e.id)) && e.job.publicUrl === job.publicUrl && e.job.path === job.path);
      if (!entry) {
        entry = entries.find(e => e.job.publicUrl === job.publicUrl && e.job.path === job.path);
        if (entry) {
          runners.delete(entry.id); entry.job = job; entry.wanted = true; entry.action = 'start'; delete entry.error; delete entry.suspendedRetry;
        } else { entry = { id: crypto.randomUUID(), job, wanted: true, action: 'start' }; entries.push(entry); }
        await saveEntry(entry); await runnerFor(entry).ready;
      }
      await kick(); return snapshot(entry.id, undefined, args.allIssues);
    }
    const entry = entries.find(e => e.id === args.id);
    if (!entry) throw new Error('Выберите задание в списке.');
    delete entry.error;
    if (action === 'delete') {
      entry.wanted = false;
      await runnerFor(entry).command('stop');
      await runnerFor(entry).waitUntilIdle();
      await completions.get(entry.id);
      // Delete only after the last checkpoint/completion has finished, so it
      // cannot resurrect the row. Receipts and downloaded files stay intact.
      await deleteEntry(entry.id);
      entries.splice(entries.indexOf(entry), 1); runners.delete(entry.id);
      await kick();
      return snapshot(args.selectedId, undefined, args.allIssues);
    }
    if (action === 'pause' || action === 'stop') {
      rememberQueuedRetry(entry);
      entry.wanted = false;
      await runnerFor(entry).command(action);
    } else if (action === 'start' || action === 'retry') {
      if (entry.job.phase === 'stopped') throw new Error('Нажмите «Скачать всё», чтобы проверить папку заново.');
      if (!active.has(entry.id)) {
        entry.wanted = true; entry.action = action === 'start' && entry.suspendedRetry ? 'retry' : action;
        entry.actionArgs = action === 'retry' ? { includePreviews: args.includePreviews === true } : entry.suspendedRetry || {};
        delete entry.suspendedRetry;
      }
    } else if (action === 'report') await runnerFor(entry).command(action);
    else throw new Error('Неизвестная команда.');
    await saveEntry(entry); await kick(); return snapshot(entry.id, undefined, args.allIssues);
  }
  function command(action, args) {
    if (action === 'status') return ready.then(() => snapshot(args?.id, args?.link, args?.allIssues));
    const result = serial.then(() => execute(action, args));
    serial = result.catch(() => {}); return result;
  }
  async function waitUntilIdle() {
    await ready; await serial; await scheduling;
    while (active.size || completions.size || entries.some(e => e.wanted)) {
      await Promise.all([...active].map(id => runners.get(id).waitUntilIdle()));
      await Promise.all([...completions.values()]);
      await new Promise(resolve => setTimeout(resolve, 0)); await scheduling;
    }
  }
  return { command, ready, waitUntilIdle };
}
