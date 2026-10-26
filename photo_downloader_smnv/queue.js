import { createVkRateLimit } from './vk-rate-limit.js';
import { trace, setLogging, logStatus, exportLog, clearLog, errorInfo } from './logging.js';
import { createRunner } from './runner.js';
import { newJob, parseLink, reportAll, summary } from './core.js';
import { waitFor } from './wait.js';
import { createDownloadPool, createVkDownloadPool, DOWNLOAD_LIMITS, VK_DOWNLOAD_LIMITS } from './pool.js';
import { DOWNLOAD_TIMEOUTS, DEFAULT_TIMEOUT_SECONDS, VK_PAGE_DELAYS, DEFAULT_VK_PAGE_DELAY_SECONDS } from './settings.js';
import { DOWNLOAD_MODES } from './modes.js';

export function createQueue({ loadEntries, saveEntry, deleteEntry = async () => {}, concurrency = Infinity,
  loadSettings = async () => ({}), saveSettings = async () => {}, onActivityChange = () => {},
  prepareDownloads = async () => {}, changeFolder = async () => {}, ...dependencies }) {
  const entries = [], runners = new Map(), active = new Set();
  const pools = new Map();
  const vkRateLimit = createVkRateLimit({ sleep: dependencies.sleep, now: dependencies.now, trace: (event, data) => trace(event, { provider: 'vk', ...data }) });
  let downloadLimit = 50, vkDownloadLimit = 30;
  const limitFor = entry => entry.job.provider === 'vk' ? vkDownloadLimit : downloadLimit;
  const forgetRunner = id => { runners.delete(id); pools.delete(id); };
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, completionRepeats = 0, vkPageDelaySeconds = DEFAULT_VK_PAGE_DELAY_SECONDS;
  const resetRepeats = entry => { entry.autoRepeats = 0; };
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
    if (!runners.has(entry.id)) {
      const pool = (entry.job.provider === 'vk' ? createVkDownloadPool : createDownloadPool)(limitFor(entry));
      pools.set(entry.id, pool);
      runners.set(entry.id, createRunner({ ...dependencies, runVkRequest: vkRateLimit.run, trace: (event, data) => trace(event, { jobId: entry.id, session: entry.job.title, provider: entry.job.provider || 'yandex', ...data }), withFileLock, runFiles: pool.run,
        getTimeout: () => timeoutSeconds * 1000, getVkPageDelay: () => vkPageDelaySeconds * 1000,
        loadJob: async () => entry.job,
        saveJob: async job => { entry.job = job; await saveEntry(entry); }
      }));
    }
    return runners.get(entry.id);
  };
  async function restore(restored, settings) {
    await setLogging(settings?.logging === true);
    trace('queue.restore', { count: restored.length });
    entries.length = 0; runners.clear(); pools.clear();
    downloadLimit = DOWNLOAD_LIMITS.includes(settings?.downloadLimit) ? settings.downloadLimit : 50;
    vkDownloadLimit = VK_DOWNLOAD_LIMITS.includes(settings?.vkDownloadLimit) ? settings.vkDownloadLimit : 30;
    timeoutSeconds = DOWNLOAD_TIMEOUTS.includes(settings?.timeoutSeconds) ? settings.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
    vkPageDelaySeconds = VK_PAGE_DELAYS.includes(settings?.vkPageDelaySeconds) ? settings.vkPageDelaySeconds :
      [15, 30, 60].includes(settings?.vkPageDelaySeconds) ? 10 : DEFAULT_VK_PAGE_DELAY_SECONDS;
    completionRepeats = [0, 1, 2, 3].includes(settings?.completionRepeats) ? settings.completionRepeats : 0;
    restored.sort((a, b) => a.job.created.localeCompare(b.job.created));
    for (const entry of restored) {
      entry.wanted = false; entries.push(entry);
      await runnerFor(entry).ready;
    }
    // Recover receipts from every old job before removing duplicate UI records.
    for (const entry of [...entries]) {
      const newer = entries.findLast(e => e.job.publicUrl === entry.job.publicUrl && e.job.path === entry.job.path);
      if (newer !== entry) {
        entries.splice(entries.indexOf(entry), 1); forgetRunner(entry.id); await deleteEntry(entry.id);
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
          active.delete(entry.id);
          const counts = summary(entry.job);
          const repeatPreviews = entry.repeatPreviews !== false;
          const repeat = entry.wanted && entry.job.phase === 'done' &&
            (entry.autoRepeats || 0) < completionRepeats &&
            (counts.failed || counts.directoriesFailed || (repeatPreviews && counts.previews));
          entry.wanted = !!repeat;
          if (repeat) {
            entry.autoRepeats = (entry.autoRepeats || 0) + 1;
            entry.action = 'retry'; entry.actionArgs = { includePreviews: repeatPreviews, preserveNewFiles: true };
          }
          await saveEntry(entry); await kick();
        }).catch(error => { active.delete(entry.id); entry.wanted = false; entry.error = error.message; })
          .finally(() => { if (completions.get(entry.id) === completion) completions.delete(entry.id); activity(); });
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
      if (entry.job.provider === 'vk' && state.running && vkRateLimit.status()) { state.current = vkRateLimit.status(); state.currentUrl = ''; }
      return { entry, state };
    }));
    const chosen = states.find(s => s.entry === selected);
    return { ...(chosen?.state || { running: false, job: null, current: '', notice: '' }),
      downloadLimit, vkDownloadLimit, timeoutSeconds, completionRepeats, vkPageDelaySeconds, ...logStatus(),
      activeDownloads: [...pools.values()].reduce((sum, pool) => sum + pool.active, 0),
      paused: !!selected?.paused,
      id: selected?.id, queued: !!selected?.wanted && !active.has(selected.id),
      notice: selected?.error || chosen?.state.notice || '',
      jobs: states.map(({ entry, state }) => ({ id: entry.id,
        autoRepeats: entry.autoRepeats || 0, completionRepeats, paused: !!entry.paused,
        title: state.job?.title || entry.job.path, running: state.running,
        queued: entry.wanted && !active.has(entry.id), phase: state.job.phase,
        done: state.job.summary.done, total: state.job.summary.total,
        summary: state.job.summary, pages: state.job.pages, current: state.current, currentUrl: state.currentUrl, notice: entry.error || state.notice,
        timing: state.job.timing, pendingDirectories: state.job.pendingDirectories,
        overallNewFiles: Math.max(0, state.job.summary.newFiles -
          (Number.isSafeInteger(entry.overallNewFilesBaseline) && entry.overallNewFilesBaseline >= 0 ? entry.overallNewFilesBaseline : 0)),
        resumable: !entry.wanted && !active.has(entry.id) && !state.running &&
          (state.job.summary.pending > 0 || state.job.pendingDirectories > 0 || !!entry.suspendedRetry || !!entry.paused),
        completed: !entry.paused && !entry.wanted && !active.has(entry.id) && !state.running && state.job.phase === 'done',
        issuesTotal: state.job.issuesTotal, ...(allIssues ? { issues: state.job.issues } : {}),
        publicUrl: entry.job.publicUrl, path: entry.job.path }))
    };
  }
  async function execute(action, args = {}) {
    await ready;
    if (action === 'status') return snapshot(args.id, args.link, args.allIssues);
    trace('command.start', { action, jobId: args.id });
    if (['scan', 'start', 'retry'].includes(action)) await prepareDownloads();
    if (action === 'stopAll' || action === 'pauseAll') {
      await scheduling;
      const targets = entries.filter(e => e.wanted || active.has(e.id));
      // Clear all queued starts before aborting a worker: its completion may
      // immediately schedule the next album otherwise.
      for (const entry of targets) { resetRepeats(entry); entry.paused = action === 'pauseAll'; rememberQueuedRetry(entry); entry.wanted = false; }
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
        resetRepeats(entry); entry.paused = false; entry.wanted = true; entry.action = entry.suspendedRetry ? 'retry' : 'start';
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
      if (targets.length) {
        // Start one common counting interval, including albums that keep running
        // and those that are not eligible for retry. Keep their individual counts.
        for (const entry of entries) entry.overallNewFilesBaseline = summary(entry.job).newFiles;
        await Promise.all(entries.map(entry => saveEntry(entry)));
      }
      for (const item of targets) {
        const entry = entries.find(e => e.id === item.id);
        resetRepeats(entry); entry.paused = false; entry.repeatPreviews = action === 'downloadAll' || args.includePreviews === true;
        entry.overallNewFilesBaseline = 0;
        entry.job.runNewFiles = 0;
        if (action === 'downloadAll') {
          const previous = entry.job;
          entry.job = newJob(previous.publicUrl + (previous.path === '/' ? '' : previous.path), previous.mode,
            { deduplicate: previous.deduplicate });
          forgetRunner(entry.id);
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
      const logging = args.logging === undefined ? logStatus().logging : args.logging;
      if (typeof logging !== 'boolean') throw new Error('Некорректная настройка логирования.');
      const limit = args.downloadLimit === undefined ? downloadLimit : args.downloadLimit;
      const vkLimit = args.vkDownloadLimit === undefined ? vkDownloadLimit : args.vkDownloadLimit;
      const timeout = args.timeoutSeconds === undefined ? timeoutSeconds : args.timeoutSeconds;
      const pageDelay = args.vkPageDelaySeconds === undefined ? vkPageDelaySeconds : args.vkPageDelaySeconds;
      if (!VK_PAGE_DELAYS.includes(pageDelay)) throw new Error('Недопустимая пауза запросов ВК.');
      const repeats = args.completionRepeats === undefined ? completionRepeats : args.completionRepeats;
      if (![0, 1, 2, 3].includes(repeats)) throw new Error('Выберите от 0 до 3 повторов после завершения.');
      if (!DOWNLOAD_LIMITS.includes(limit)) throw new Error('Недопустимое число загрузок.');
      if (!VK_DOWNLOAD_LIMITS.includes(vkLimit)) throw new Error('Для ВК выберите 1, 4+1, 8+2, 12+4, 20+10, 25+15, 50+30, 70+40, 100+50, 150+70 или 200+100.');
      if (!DOWNLOAD_TIMEOUTS.includes(timeout)) throw new Error('Недопустимое время ожидания.');
      await saveSettings({ downloadLimit: limit, vkDownloadLimit: vkLimit, timeoutSeconds: timeout, completionRepeats: repeats, logging, vkPageDelaySeconds: pageDelay });
      await setLogging(logging);
      trace('settings.changed', { downloadLimit: limit, vkDownloadLimit: vkLimit, timeoutSeconds: timeout, vkPageDelaySeconds: pageDelay });
      downloadLimit = limit; vkDownloadLimit = vkLimit; timeoutSeconds = timeout; completionRepeats = repeats; vkPageDelaySeconds = pageDelay;
      for (const entry of entries) pools.get(entry.id)?.setLimit(limitFor(entry));
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
          forgetRunner(entry.id); entry.job = job; entry.overallNewFilesBaseline = 0;
          entry.wanted = true; entry.action = 'start'; delete entry.error; delete entry.suspendedRetry;
        } else { entry = { id: crypto.randomUUID(), job, wanted: true, action: 'start' }; entries.push(entry); }
        resetRepeats(entry); entry.paused = false; entry.repeatPreviews = true;
        await saveEntry(entry); await runnerFor(entry).ready;
      }
      await kick(); return snapshot(entry.id, undefined, args.allIssues);
    }
    const entry = entries.find(e => e.id === args.id);
    if (!entry) throw new Error('Выберите задание в списке.');
    delete entry.error;
    if (['start', 'retry', 'pause', 'stop', 'mode'].includes(action)) resetRepeats(entry);
    if (action === 'retry') entry.repeatPreviews = args.includePreviews === true;
    if (action === 'pause') entry.paused = true;
    if (['start', 'retry', 'stop'].includes(action)) entry.paused = false;
    if (action === 'mode') {
      if (!DOWNLOAD_MODES.includes(args.mode)) throw new Error('Неизвестный режим скачивания.');
      const resume = entry.wanted || active.has(entry.id);
      const nextAction = active.has(entry.id) ? 'start' : entry.action;
      const nextArgs = active.has(entry.id) ? {} : entry.actionArgs;
      entry.wanted = false;
      await runnerFor(entry).command('pause');
      await runnerFor(entry).waitUntilIdle();
      await completions.get(entry.id);
      await runnerFor(entry).command('mode', { mode: args.mode });
      if (resume) { entry.paused = false; entry.wanted = true; entry.action = nextAction || 'start'; entry.actionArgs = nextArgs || {}; }
      await saveEntry(entry); await kick();
      return snapshot(entry.id, undefined, args.allIssues);
    }
    if (action === 'delete') {
      entry.wanted = false;
      await runnerFor(entry).command('stop');
      await runnerFor(entry).waitUntilIdle();
      await completions.get(entry.id);
      // Delete only after the last checkpoint/completion has finished, so it
      // cannot resurrect the row. Receipts and downloaded files stay intact.
      await deleteEntry(entry.id);
      entries.splice(entries.indexOf(entry), 1); forgetRunner(entry.id);
      await kick();
      return snapshot(args.selectedId, undefined, args.allIssues);
    }
    if (action === 'pause' || action === 'stop') {
      rememberQueuedRetry(entry);
      entry.wanted = false;
      await runnerFor(entry).command(action);
    } else if (action === 'start' || action === 'retry') {
      if (entry.job.phase === 'stopped' && !args.resumeStopped) throw new Error('Нажмите «Скачать всё», чтобы проверить папку заново.');
      if (!active.has(entry.id)) {
        entry.wanted = true; entry.action = action === 'start' && entry.suspendedRetry ? 'retry' : action;
        entry.actionArgs = action === 'retry' ? { includePreviews: args.includePreviews === true } : { ...entry.suspendedRetry, resumeStopped: args.resumeStopped === true };
        if (entry.action === 'retry' && !entry.actionArgs.preserveNewFiles) { entry.job.runNewFiles = 0; entry.overallNewFilesBaseline = 0; }
        delete entry.suspendedRetry;
      }
    } else if (action === 'report') await runnerFor(entry).command(action);
    else throw new Error('Неизвестная команда.');
    await saveEntry(entry); await kick(); return snapshot(entry.id, undefined, args.allIssues);
  }
  function command(action, args) {
    if (action === 'exportLog') return ready.then(() => exportLog()).then(text => ({ text }));
    if (action === 'clearLog') return ready.then(clearLog).then(() => snapshot(args?.id));
    if (action === 'status') return ready.then(() => snapshot(args?.id, args?.link, args?.allIssues));
    const result = serial.then(() => execute(action, args));
    serial = result.then(() => trace('command.end', { action, jobId: args?.id }), error => trace('command.error', { action, jobId: args?.id, ...errorInfo(error) })); return result;
  }
  async function waitUntilIdle() {
    await ready; await serial; await scheduling;
    while (active.size || completions.size || entries.some(e => e.wanted)) {
      await Promise.all([...active].map(id => runners.get(id).waitUntilIdle()));
      await Promise.all([...completions.values()]);
      await new Promise(resolve => setTimeout(resolve, 0)); await scheduling;
    }
  }
  let lastHeartbeat = -Infinity;
  function heartbeat() {
    if (!logStatus().logging) { lastHeartbeat = -Infinity; return; }
    const at = (dependencies.now || Date.now)();
    if (at >= lastHeartbeat && at - lastHeartbeat < 30000) return;
    lastHeartbeat = at;
    trace('queue.heartbeat', { active: active.size, pending: entries.filter(e => e.wanted).length, downloadLimit, vkDownloadLimit, timeoutSeconds, vkPageDelaySeconds });
    for (const id of active) runners.get(id)?.heartbeat();
  }
  return { command, ready, waitUntilIdle, heartbeat };
}
