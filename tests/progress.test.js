import test from 'node:test';
import assert from 'node:assert/strict';
import { overallProgress } from '../extension/progress.js';

test('overall progress is weighted by file count, not by album percentages', () => {
  const result = overallProgress([
    { running: true, summary: { total: 100, done: 90 } },
    { running: true, summary: { total: 900, done: 10 } }
  ]);
  assert.equal(result.visible, true); assert.equal(result.total, 1000);
  assert.equal(result.done, 100); assert.equal(result.percent, 10);
});

test('all jobs contribute to totals and visibility, including completed and stopped jobs', () => {
  const jobs = [
    { running: true, phase: 'scanning', pages: 2, summary: { total: 10, done: 2, failed: 1, directoriesFailed: 3, newFiles: 1 } },
    { queued: true, summary: { total: 100 } },
    { phase: 'done', pages: 3, summary: { total: 20, done: 18, skipped: 2, reused: 5, originals: 12, previews: 6, newFiles: 3 } },
    { phase: 'stopped', summary: { total: 50, done: 5 } }
  ];
  const result = overallProgress(jobs);
  assert.equal(result.visible, true); assert.equal(result.active, 1); assert.equal(result.scanning, 1);
  assert.equal(result.total, 180); assert.equal(result.processed, 28);
  assert.equal(result.directoriesFailed, 3); assert.equal(result.pages, 5);
  assert.equal(result.reused, 5); assert.equal(result.originals, 12); assert.equal(result.previews, 6);
  assert.equal(result.newFiles, 4);
  jobs[2].summary.newFiles = 0;
  assert.equal(overallProgress(jobs).newFiles, 1);
  jobs[1].running = true;
  assert.equal(overallProgress(jobs).visible, true);
});

test('empty or newly scanning queues have finite zero progress', () => {
  assert.equal(overallProgress([]).visible, false);
  assert.equal(overallProgress([{ running: true }]).visible, false);
  assert.equal(overallProgress([{ phase: 'done' }, { phase: 'stopped' }]).visible, true);
  const result = overallProgress([{ running: true }, { running: true }]);
  assert.equal(result.visible, true); assert.equal(result.total, 0); assert.equal(result.percent, 0);
});
