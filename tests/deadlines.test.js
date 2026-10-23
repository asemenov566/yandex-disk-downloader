import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeadlineClock } from '../extension/deadlines.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('background replies expire deadlines even when document timers never run', async () => {
  let now = 0, wake, sleeps = 0;
  const fired = [];
  const clock = createDeadlineClock({ now: () => now, sleep: async ms => {
    assert.equal(ms, 500); sleeps++;
    await new Promise(resolve => { wake = resolve; });
  } });
  const cancel = clock(() => fired.push('cancelled'), 1000);
  clock(() => fired.push('short'), 25000);
  clock(() => fired.push('long'), 240000);
  assert.equal(sleeps, 1); cancel();
  now = 26000; wake(); await tick();
  assert.deepEqual(fired, ['short']); assert.equal(sleeps, 2);
  now = 241000; wake(); await tick();
  assert.deepEqual(fired, ['short', 'long']); assert.equal(sleeps, 2);
  clock(() => fired.push('new'), 500);
  assert.equal(sleeps, 3); now += 500; wake(); await tick();
  assert.equal(fired.at(-1), 'new');
});
test('cancelling or refreshing a timeout cannot expire its replacement', async () => {
  let now = 0, wake, fired = 0;
  const clock = createDeadlineClock({ now: () => now, sleep: () => new Promise(resolve => { wake = resolve; }) });
  const cancel = clock(() => { fired++; }, 500);
  cancel(); now = 400;
  clock(() => { fired++; }, 1000);
  now = 1000; wake(); await tick(); assert.equal(fired, 0);
  now = 1400; wake(); await tick(); assert.equal(fired, 1);
});
