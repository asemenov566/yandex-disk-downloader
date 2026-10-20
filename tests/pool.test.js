import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadPool } from '../extension/pool.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('live limit increases immediately and decreases without cancelling active files', async () => {
  const pool = createDownloadPool();
  const started = [], gates = [];
  const done = pool.run(Array.from({ length: 9 }, (_, n) => n), n => {
    started.push(n); return new Promise(resolve => gates.push(resolve));
  });
  await tick(); assert.equal(started.length, 1);
  pool.setLimit(5); await tick(); assert.equal(started.length, 5);
  pool.setLimit(1);
  for (let i = 0; i < 4; i++) gates[i]();
  await tick(); assert.equal(started.length, 5);
  gates[4](); await tick(); assert.equal(started.length, 6);
  pool.setLimit(50); await tick(); assert.equal(started.length, 9);
  gates.forEach(resolve => resolve()); await done;
  assert.equal(pool.active, 0);
  assert.throws(() => pool.setLimit(51)); assert.throws(() => pool.setLimit(2));
});

test('budget is shared across albums, aborting a waiter does not start its files', async () => {
  const pool = createDownloadPool();
  let release;
  const first = pool.run([1], () => new Promise(resolve => { release = resolve; }));
  await tick();
  const controller = new AbortController();
  let called = false;
  const second = pool.run([2], () => { called = true; }, controller.signal);
  controller.abort(); await assert.rejects(second, { name: 'AbortError' });
  assert.equal(called, false); assert.equal(pool.active, 1);
  release(); await first; assert.equal(pool.active, 0);
});

test('failure stops scheduling new items and waits for in-flight work before rejecting', async () => {
  const pool = createDownloadPool(5);
  let release, fail;
  const started = [];
  const done = pool.run([0,1,2,3,4,5], n => {
    started.push(n);
    if (n === 0) return new Promise((_, reject) => { fail = reject; });
    if (n === 1) return new Promise(resolve => { release = resolve; });
    return new Promise(resolve => setImmediate(resolve));
  });
  await Promise.resolve(); fail(new Error('broken'));
  let settled = false;
  const checked = assert.rejects(done, /broken/).then(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(started.includes(5), false);
  release(); await checked; assert.equal(pool.active, 0);
});
