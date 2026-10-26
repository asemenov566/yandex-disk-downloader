import test from 'node:test';
import assert from 'node:assert/strict';
import { overallProgress, jobProgress, sortedSessions } from '../photo_downloader_smnv/progress.js';

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
  assert.equal(result.total, 180); assert.equal(result.processed, 27);
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
  assert.equal(overallProgress([{ running: true }]).visible, true);
  assert.equal(overallProgress([{ phase: 'done' }, { phase: 'stopped' }]).visible, true);
  const result = overallProgress([{ running: true }, { running: true }]);
  assert.equal(result.visible, true); assert.equal(result.total, 0); assert.equal(result.percent, 0);
});

test('common attempt counts take priority over individual last-run totals, including zero', () => {
  assert.equal(overallProgress([
    { summary: { newFiles: 607 }, overallNewFiles: 1 },
    { summary: { newFiles: 113 }, overallNewFiles: 113 },
    { summary: { newFiles: 20 }, overallNewFiles: 0 }
  ]).newFiles, 114);
});

test('errors never increase individual or overall percentage; skipped files remain accounted for', () => {
  const job = { summary: { total: 100, done: 80, failed: 20, previews: 10 } };
  assert.equal(jobProgress(job), 80); assert.equal(overallProgress([job]).percent, 80);
  assert.equal(jobProgress({ summary: { total: 100, done: 80, skipped: 10, failed: 10 } }), 90);
});
test('paused sessions precede running sessions and only finished sessions move to bottom', () => {
  const jobs = [{ id: 'done', phase: 'done', completed: true }, { id: 'running', running: true, phase: 'done' },
    { id: 'paused', phase: 'downloading' }, { id: 'queued', queued: true }, { id: 'paused2', phase: 'ready' }];
  assert.deepEqual(sortedSessions(jobs).map(j => j.id), ['paused', 'paused2', 'running', 'queued', 'done']);
  assert.equal(jobs[0].id, 'done');
});
