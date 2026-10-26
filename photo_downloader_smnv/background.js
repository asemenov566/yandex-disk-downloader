import { handleVkRequest } from './vk-browser.js';
import { vkVideoUrl } from './vk.js';
let creating;
const activityAlarm = 'download-activity';
let powerUpdates = Promise.resolve();
function setActivity(active) {
  powerUpdates = powerUpdates.catch(() => {}).then(async () => {
    if (active) {
      chrome.power.requestKeepAwake('system');
      if (!await chrome.alarms.get(activityAlarm)) await chrome.alarms.create(activityAlarm, { periodInMinutes: 0.5 });
    } else {
      chrome.power.releaseKeepAwake();
      await chrome.alarms.clear(activityAlarm);
    }
  });
  return powerUpdates;
}
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== activityAlarm) return;
  // A real browser event checks the offscreen worker even with no UI activity.
  // Never start a new runner or resume a paused queue from this watchdog.
  try {
    const result = await chrome.runtime.sendMessage({ target: 'runner', action: 'activity' });
    await setActivity(result?.ok && result.value === true);
  } catch { await setActivity(false); }
});
async function ensureRunner() {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (!contexts.length && !creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS'],
      justification: 'Download and validate photos, create Blob URLs, and keep the queue independent of the popup.'
    }).finally(() => { creating = null; });
  }
  if (creating) await creating;
  // A context can already exist while its module is still loading. Confirm
  // the listener is ready before sending a command, without replaying commands.
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({ target: 'runner', action: 'activity' });
      if (response?.ok) return;
    } catch { /* Cold start: message listener is not installed yet. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Фоновый обработчик не успел запуститься. Повторите действие.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'background') return;
  (async () => {
    if (message.type === 'vk-api') {
      if (sender.url !== chrome.runtime.getURL('offscreen.html')) throw new Error('Недопустимый отправитель.');
      return handleVkRequest(message);
    }
    if (message.type === 'activity' || message.type === 'delay') {
      if (sender.url !== chrome.runtime.getURL('offscreen.html')) throw new Error('Недопустимый отправитель.');
      if (message.type === 'activity') return setActivity(message.active === true);
      if (!Number.isFinite(message.ms) || message.ms < 0 || message.ms > 1000) throw new Error('Недопустимая задержка.');
      return new Promise(resolve => setTimeout(resolve, message.ms));
    }
    if (message.type === 'download-api') {
      if (sender.url !== chrome.runtime.getURL('offscreen.html')) throw new Error('Недопустимый отправитель.');
      if (message.method === 'download') {
        const url = new URL(message.args.url);
        const blob = message.args.url.startsWith('blob:' + chrome.runtime.getURL(''));
        let video = false;
        if (message.args.filename?.startsWith('vk-messeger/') && message.args.filename.endsWith('.mp4')) {
          try { video = !!vkVideoUrl(url.href); } catch { /* Not a VK media host. */ }
        }
        const remote = video || url.protocol === 'https:' && (url.hostname === 'downloader.disk.yandex.ru' || url.hostname.endsWith('.storage.yandex.net'));
        if (!blob && !remote) throw new Error('Недопустимый адрес файла.');
        return chrome.downloads.download(message.args);
      }
      if (!Number.isInteger(message.id)) throw new Error('Некорректный номер загрузки.');
      if (message.method === 'search') return chrome.downloads.search({ id: message.id });
      if (message.method === 'cancel') return chrome.downloads.cancel(message.id);
      if (message.method === 'discardInvalid') {
        const [item] = await chrome.downloads.search({ id: message.id });
        if (!item || item.byExtensionId !== chrome.runtime.id || item.state !== 'complete' ||
            !Number.isFinite(message.expectedSize) || item.fileSize === message.expectedSize) {
          throw new Error('Размер файла не подтверждает ошибку загрузки.');
        }
        return chrome.downloads.removeFile(message.id);
      }
      if (message.method === 'removeFile') {
        const [item] = await chrome.downloads.search({ id: message.id });
        if (!item || item.byExtensionId !== chrome.runtime.id || !/\.preview\.(jpg|png|webp|gif)$/i.test(item.filename)) {
          throw new Error('Удалять можно только превью, сохранённое этим расширением.');
        }
        return chrome.downloads.removeFile(message.id);
      }
      throw new Error('Неизвестная операция загрузки.');
    }
    if (message.type !== 'command') throw new Error('Неизвестная команда.');
    await ensureRunner();
    const result = await chrome.runtime.sendMessage({ target: 'runner', action: message.action, args: message.args });
    if (!result?.ok) throw new Error(result?.error || 'Фоновая очередь не ответила.');
    return result.value;
  })().then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
  return true;
});
