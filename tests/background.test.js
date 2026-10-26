import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { vkVideoUrl } from '../photo_downloader_smnv/vk.js';

async function harness(coldAttempts = 0) {
  const messages = [], power = [], alarms = new Map();
  let listener, alarmListener, live = true;
  const chrome = {
    runtime: { id: 'test', getURL: path => 'chrome-extension://test/' + path,
      getContexts: async () => [{}],
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => {
        messages.push(message);
        if (message.action === 'activity' && coldAttempts-- > 0) throw new Error('Receiving end does not exist.');
        return { ok: true, value: live };
      }
    },
    power: { requestKeepAwake: value => power.push(value), releaseKeepAwake: () => power.push('released') },
    alarms: { get: async key => alarms.get(key), create: async (key, value) => alarms.set(key, value),
      clear: async key => alarms.delete(key), onAlarm: { addListener: fn => { alarmListener = fn; } } }
  };
  const source = (await readFile(new URL('../photo_downloader_smnv/background.js', import.meta.url), 'utf8'))
    .replace("import { handleVkRequest } from './vk-browser.js';", '')
    .replace("import { vkVideoUrl } from './vk.js';", '');
  vm.runInNewContext(source, { chrome, setTimeout, URL, vkVideoUrl, handleVkRequest: async () => ({ ok: true }) });
  const send = (message, url = 'chrome-extension://test/offscreen.html') => new Promise(resolve =>
    listener({ target: 'background', ...message }, { id: 'test', url }, resolve));
  return { send, power, alarms, messages, alarm: () => alarmListener({ name: 'download-activity' }), setLive: value => { live = value; } };
}

test('activity enables system wake protection; watchdog checks without UI or resuming paused work', async () => {
  const h = await harness();
  assert.equal((await h.send({ type: 'activity', active: true })).ok, true);
  assert.deepEqual(h.power, ['system']); assert.equal(h.alarms.get('download-activity').periodInMinutes, 0.5);
  await h.alarm(); assert.equal(h.messages[0].action, 'activity');
  h.setLive(false); await h.alarm();
  assert.equal(h.power.at(-1), 'released'); assert.equal(h.alarms.size, 0);
  assert(h.messages.every(m => m.action === 'activity'));
});

test('background delay works without a UI page and rejects unauthorized or long requests', async () => {
  const h = await harness();
  assert.equal((await h.send({ type: 'delay', ms: 1 })).ok, true);
  assert.equal((await h.send({ type: 'delay', ms: 60000 })).ok, false);
  assert.equal((await h.send({ type: 'activity', active: true }, 'chrome-extension://test/app.html')).ok, false);
  assert.deepEqual(h.power, []);
});

test('cold start waits for listener before sending a command exactly once', async () => {
  const h = await harness(2);
  const result = await h.send({ type: 'command', action: 'scan', args: {} }, 'chrome-extension://test/app.html');
  assert.equal(result.ok, true);
  assert.deepEqual(h.messages.map(m => m.action), ['activity', 'activity', 'activity', 'scan']);
});

test('VK API bridge only accepts the offscreen worker, not a tab or popup', async () => {
  const h = await harness();
  assert.equal((await h.send({ type: 'vk-api', action: 'prepare' })).ok, true);
  assert.equal((await h.send({ type: 'vk-api', action: 'prepare' }, 'chrome-extension://test/app.html')).ok, false);
  assert.equal((await h.send({ type: 'vk-api', action: 'prepare' }, 'https://vk.ru/im/convo/1')).ok, false);
});

test('removed native date bridge rejects all operations', async () => {
  const h = await harness();
  assert.equal((await h.send({ type: 'native-dates', payload: { action: 'ping' } })).ok, false);
  assert.equal((await h.send({ type: 'native-dates', payload: { action: 'delete' } })).ok, false);
  assert.equal((await h.send({ type: 'native-dates', payload: { action: 'apply' } }, 'https://vk.ru')).ok, false);
  assert.equal((await h.send({ type: 'native-dates', payload: { action: 'apply' } }, 'chrome-extension://test/app.html')).ok, false);
});
