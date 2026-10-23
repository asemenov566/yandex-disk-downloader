import test from 'node:test';
import assert from 'node:assert/strict';
import { activeTime, jobTiming, overallTiming, timingText, duration } from '../extension/timing.js';
import { overallProgress } from '../extension/progress.js';
import { createRunner } from '../extension/runner.js';
import { newJob } from '../extension/core.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } throw new Error('Condition not reached'); }

test('overall active time merges overlapping jobs but excludes pauses and idle gaps', () => {
  assert.equal(activeTime([[0, 1000], [500, 2000], [4000, 5000], [5000, 6000], [NaN, 8]]), 4000);
  const total = overallTiming([
    { running: true, timing: { intervals: [[0, 1000]], remainingMs: 5000 } },
    { running: true, timing: { intervals: [[500, 2000]], remainingMs: 9000 } }
  ]);
  assert.equal(total.elapsedMs, 2000); assert.equal(total.remainingMs, 9000);
  assert.equal(overallTiming([{ resumable: true, timing: { intervals: [[0, 1000]] } }]).remainingMs, null);
  assert.equal(overallTiming([{ running: true, timing: { remainingMs: null } }]).remainingMs, null);
});

test('ETA needs samples and marks unknown VK totals as partial; bars cannot show completion while paginating', () => {
  const job = { timeIntervals: [[0, 10000]], timingFiles: 2 };
  assert.equal(jobTiming(job, { pending: 3 }, 0).remainingMs, 15000);
  assert.equal(jobTiming({ ...job, timingFiles: 1 }, { pending: 3 }, 0).remainingMs, null);
  const partial = jobTiming(job, { pending: 3 }, 1);
  assert(partial.partial); assert.match(timingText(partial, true), /найденные файлы/);
  assert.equal(jobTiming(job, { pending: 0 }, 1).remainingMs, null);
  assert.equal(jobTiming(job, { pending: 0 }, 0).remainingMs, 0);
  assert.equal(overallProgress([{ pendingDirectories: 1, summary: { total: 30, done: 30 } }]).percent, 99);
  assert.equal(duration(3661000), '1 ч 1 мин 1 с');
});

test('elapsed time and ETA survive pause and restoration without including time spent paused', async () => {
  let at = 1000, saved, gates = [];
  const job = newJob('https://disk.yandex.ru/d/timing');
  job.directories[0].state = 'done'; job.title = 'Timing'; job.folder = 'yandex-disk/Timing'; job.phase = 'ready';
  job.files = [1, 2, 3].map(id => ({ path: `/${id}.jpg`, local: `${id}.jpg`, name: `${id}.jpg`, size: 3, kind: 'photo', state: 'pending' }));
  const deps = { now: () => at, loadJob: async () => job, saveJob: async value => { saved = structuredClone(value); },
    getPhoto: async (_job, _file, _kind, signal) => {
      await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        gates.push(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      return new Blob(['abc'], { type: 'image/jpeg' });
    }, saveLocal: async path => ({ savedPath: path, savedBytes: 3, localFile: true }) };
  const runner = createRunner(deps); await runner.command('start'); await until(() => gates.length === 1);
  at = 6000; assert.equal((await runner.command('status')).job.timing.elapsedMs, 5000);
  gates[0](); await until(() => gates.length === 2);
  at = 11000; gates[1](); await until(() => gates.length === 3);
  assert.equal((await runner.command('status')).job.timing.remainingMs, 5000);
  at = 13000; await runner.command('pause'); await runner.waitUntilIdle();
  at = 73000; assert.equal((await runner.command('status')).job.timing.elapsedMs, 12000);
  const restored = createRunner({ ...deps, loadJob: async () => saved });
  assert.equal((await restored.command('status')).job.timing.elapsedMs, 12000);
  await restored.command('start'); await until(() => gates.length === 4);
  at = 78000; gates[3](); await restored.waitUntilIdle();
  const status = await restored.command('status');
  assert.equal(status.job.timing.elapsedMs, 17000); assert.equal(status.job.timing.remainingMs, 0);
  assert.equal(status.job.phase, 'done'); assert.equal(saved.timingFiles, 3);
});

test('retry can use a previous measured rate before its first successful file', () => {
  const timing = jobTiming({ timeIntervals: [[0, 500]], timingFiles: 0, previousMsPerFile: 2000 }, { pending: 3 }, 0);
  assert.equal(timing.remainingMs, 6000);
  assert.match(timingText(timing, true), /осталось ≈ 6 с/);
});
