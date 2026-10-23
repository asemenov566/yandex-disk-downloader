import { createFileLog } from './file-log.js';
import { configureLogging } from './logging.js';
import { useBackgroundDeadlines } from './deadlines.js';
import { createQueue } from './queue.js';
import { resource, getPhoto, originalUrl } from './network.js';
import * as cache from './storage.js';
import { createPortableStorage } from './portable-state.js';
import { requireFolder, findLocalFiles, saveLocalFile, verifyLocalRecord } from './local-files.js';
import { createVkProvider } from './vk-provider.js';

let busy = false;
// Keep the granted handle in the long-lived document, rather than reconstructing
// it for each file or depending on the popup's lifetime.
let selectedFolder = cache.loadDownloadFolder();
const { version: extensionVersion } = await (await fetch(new URL('./manifest.json', import.meta.url))).json();
const portable = createPortableStorage({ cache, extensionVersion });
function activity(active) {
  busy = active;
  chrome.runtime.sendMessage({ target: 'background', type: 'activity', active }).catch(() => {});
}

async function downloadApi(method, args) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'download-api', method,
    ...(method === 'download' ? { args } : { id: typeof args === 'number' ? args : args.id, expectedSize: args?.expectedSize }) });
  if (!response?.ok) throw new Error(response?.error || 'Chrome не ответил на запрос загрузки.');
  return response.value;
}
async function backgroundSleep(ms) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'delay', ms });
  if (!response?.ok) throw new Error(response?.error || 'Фоновый таймер недоступен.');
}
useBackgroundDeadlines(backgroundSleep);
await cache.deleteLegacyDebugLog();
configureLogging(createFileLog({ getDirectory: portable.logDirectory }));
const vk = createVkProvider({ sleep: backgroundSleep });
const runner = createQueue({ loadEntries: portable.loadEntries, saveEntry: portable.saveEntry, deleteEntry: portable.deleteEntry,
  loadHistory: portable.loadHistory, saveHistory: portable.saveHistory, loadSettings: portable.loadSettings, saveSettings: portable.saveSettings,
  prepareDownloads: async () => portable.prepare(await selectedFolder),
  changeFolder: async token => {
    const handle = await requireFolder(await cache.loadFolderCandidate(token));
    const restored = await portable.changeFolder(handle);
    await cache.saveDownloadFolder(handle); selectedFolder = Promise.resolve(handle);
    return restored;
  },
  findLocal: async (job, file) => findLocalFiles(await selectedFolder, job, file),
  saveLocal: async (path, source, options) => saveLocalFile(await selectedFolder, path, source, options),
  verifyLocal: async record => verifyLocalRecord(await selectedFolder, record),
  onActivityChange: active => { if (busy !== active) activity(active); },
  // Short polling delays run in the service worker, not a throttled hidden page.
  sleep: backgroundSleep,
  resource, vk, getPhoto: (job, ...args) => job.provider === 'vk' ? vk.getPhoto(job, ...args) : getPhoto(job, ...args),
  getOriginalUrl: (job, ...args) => job.provider === 'vk' ? vk.getOriginalUrl(job, ...args) : originalUrl(job, ...args), downloads: {
  download: args => downloadApi('download', args), search: args => downloadApi('search', args), cancel: id => downloadApi('cancel', id),
  removeFile: id => downloadApi('removeFile', id),
  discardInvalid: args => downloadApi('discardInvalid', args)
} });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'runner') return;
  if (message.action === 'activity') { runner.heartbeat(); respond({ ok: true, value: busy }); return; }
  runner.command(message.action, message.args).then(
    value => respond({ ok: true, value: { ...value, ...((portable.error || portable.warning) ? { notice: portable.error?.message || portable.warning } : {}) } }), error => respond({ ok: false, error: error.message })
  );
  return true;
});
