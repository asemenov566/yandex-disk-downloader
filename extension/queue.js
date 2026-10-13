import { createRunner } from './runner.js';
import { newJob, parseLink } from './core.js';

export function createQueue({ loadEntries, saveEntry, deleteEntry = async () => {}, concurrency = Infinity, ...dependencies }) {
  const entries = [], runners = new Map(), active = new Set();
  let serial = Promise.resolve(), scheduling = Promise.resolve();
  const runnerFor = entry => {
    if (!runners.has(entry.id)) runners.set(entry.id, createRunner({ ...dependencies,
      loadJob: async () => entry.job,
      saveJob: async job => { entry.job = job; await saveEntry(entry); }
    }));
    return runners.get(entry.id);
  };
  const ready = (async () => {
    const restored = (await loadEntries()).sort((a, b) => a.job.created.localeCompare(b.job.created));
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
  })();
  function overlaps(a, b) {
    if (a.publicUrl !== b.publicUrl) return false;
    const x = a.path.replace(/\/+$/, '') + '/', y = b.path.replace(/\/+$/, '') + '/';
    return x.startsWith(y) || y.startsWith(x);
  }
  function kick() {
    scheduling = scheduling.catch(() => {}).then(async () => {
      for (const entry of entries) {
        if (active.size >= concurrency) break;
        if (!entry.wanted || active.has(entry.id)) continue;
        if (entries.some(other => active.has(other.id) && overlaps(entry.job, other.job))) continue;
        const runner = runnerFor(entry);
        active.add(entry.id);
        try { await runner.command(entry.action || 'start'); }
        catch (error) { active.delete(entry.id); entry.wanted = false; entry.error = error.message; await saveEntry(entry); continue; }
        runner.waitUntilIdle().then(async () => {
          active.delete(entry.id); entry.wanted = false; await saveEntry(entry); await kick();
        }).catch(error => { active.delete(entry.id); entry.wanted = false; entry.error = error.message; });
      }
    });
    return scheduling;
  }
  async function snapshot(id, link) {
    let selected = entries.find(e => e.id === id);
    if (!selected && link) {
      try {
        const target = parseLink(link);
        selected = entries.findLast(e => e.job.publicUrl === target.publicUrl && e.job.path === target.path);
      } catch { /* Active tab need not be a public Yandex link. */ }
    }
    selected ||= entries.at(-1);
    const states = await Promise.all(entries.map(async entry => {
      const state = await runnerFor(entry).command('status');
      return { entry, state };
    }));
    const chosen = states.find(s => s.entry === selected);
    return { ...(chosen?.state || { running: false, job: null, current: '', notice: '' }),
      id: selected?.id, queued: !!selected?.wanted && !active.has(selected.id),
      notice: selected?.error || chosen?.state.notice || '',
      jobs: states.map(({ entry, state }) => ({ id: entry.id,
        title: state.job?.title || entry.job.path, running: state.running,
        queued: entry.wanted && !active.has(entry.id), phase: state.job.phase,
        done: state.job.summary.done, total: state.job.summary.total,
        publicUrl: entry.job.publicUrl, path: entry.job.path }))
    };
  }
  async function execute(action, args = {}) {
    await ready;
    if (action === 'status') return snapshot(args.id, args.link);
    if (action === 'scan') {
      const job = newJob(args.link, args.mode);
      let entry = entries.find(e => (e.wanted || active.has(e.id)) && e.job.publicUrl === job.publicUrl && e.job.path === job.path);
      if (!entry) {
        entry = entries.find(e => e.job.publicUrl === job.publicUrl && e.job.path === job.path);
        if (entry) {
          runners.delete(entry.id); entry.job = job; entry.wanted = true; entry.action = 'start'; delete entry.error;
        } else { entry = { id: crypto.randomUUID(), job, wanted: true, action: 'start' }; entries.push(entry); }
        await saveEntry(entry); await runnerFor(entry).ready;
      }
      await kick(); return snapshot(entry.id);
    }
    const entry = entries.find(e => e.id === args.id);
    if (!entry) throw new Error('Выберите задание в списке.');
    delete entry.error;
    if (action === 'pause' || action === 'stop') {
      entry.wanted = false;
      await runnerFor(entry).command(action);
    } else if (action === 'start' || action === 'retry') {
      if (entry.job.phase === 'stopped') throw new Error('Нажмите «Скачать всё», чтобы проверить папку заново.');
      if (!active.has(entry.id)) { entry.wanted = true; entry.action = action; }
    } else if (action === 'report') await runnerFor(entry).command(action);
    else throw new Error('Неизвестная команда.');
    await saveEntry(entry); await kick(); return snapshot(entry.id);
  }
  function command(action, args) {
    if (action === 'status') return ready.then(() => snapshot(args?.id, args?.link));
    const result = serial.then(() => execute(action, args));
    serial = result.catch(() => {}); return result;
  }
  async function waitUntilIdle() {
    await ready; await serial; await scheduling;
    while (active.size || entries.some(e => e.wanted)) {
      await Promise.all([...active].map(id => runners.get(id).waitUntilIdle()));
      await new Promise(resolve => setTimeout(resolve, 0)); await scheduling;
    }
  }
  return { command, ready, waitUntilIdle };
}
