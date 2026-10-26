import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadPool, createVkDownloadPool, VK_DOWNLOAD_PRESETS } from '../photo_downloader_smnv/pool.js';

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

test('budget is shared across batches in one pool, aborting a waiter does not start its files', async () => {
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

test('VK presets reserve independent photo/video capacity and one means one file total', async () => {
  for (const preset of VK_DOWNLOAD_PRESETS) {
    const pool = createVkDownloadPool(preset.value), gates = [], started = { photo: 0, video: 0 };
    const controller = new AbortController();
    const work = file => { started[file.kind]++; return new Promise(resolve => gates.push(resolve)); };
    const first = pool.run(Array.from({ length: 400 }, () => ({ kind: 'photo' })), work, controller.signal);
    const second = pool.run(Array.from({ length: 400 }, () => ({ kind: 'video' })), work, controller.signal);
    // Attach handlers before cancelling the pending batches.
    const finished = Promise.allSettled([first, second]);
    await tick();
    assert.deepEqual(started, preset.value === 1 ? { photo: 1, video: 0 } : { photo: preset.photos, video: preset.videos });
    assert.equal(pool.active, preset.value);
    controller.abort(); gates.forEach(resolve => resolve());
    assert((await finished).every(result => result.status === 'rejected'));
    assert.equal(pool.active, 0);
  }
});

test('VK slot changes apply to both waiting batches without cancelling existing downloads', async () => {
  const pool = createVkDownloadPool(5), gates = [], started = [];
  let open = false;
  const work = file => { started.push(file.kind); return open ? undefined : new Promise(resolve => gates.push(resolve)); };
  const done = Promise.all(['photo', 'video'].map(kind => pool.run(Array.from({ length: 30 }, () => ({ kind })), work)));
  await tick(); assert.equal(pool.active, 5);
  pool.setLimit(30); await tick();
  assert.equal(started.filter(k => k === 'photo').length, 20);
  assert.equal(started.filter(k => k === 'video').length, 10);
  pool.setLimit(1); await tick(); assert.equal(pool.active, 30);
  gates.slice(0, -1).forEach(resolve => resolve()); await tick(); assert.equal(started.length, 30);
  open = true; gates.at(-1)(); await done;
  assert.equal(started.length, 60); assert.equal(pool.active, 0);
  assert.throws(() => pool.setLimit(20)); assert.throws(() => pool.setLimit(50));
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

test('Yandex higher limits start exactly the selected number and leave the tail queued', async () => {
  for (const limit of [100,150,200]) {
    const pool = createDownloadPool(limit), gates = [];
    const controller = new AbortController();
    const done = pool.run(Array.from({ length: limit + 10 }, (_, i) => i), () => new Promise(resolve => gates.push(resolve)), controller.signal);
    const checked = assert.rejects(done, { name: 'AbortError' });
    await tick(); assert.equal(gates.length, limit); assert.equal(pool.active, limit);
    controller.abort(); gates.forEach(resolve => resolve()); await checked;
    assert.equal(pool.active, 0);
  }
});
