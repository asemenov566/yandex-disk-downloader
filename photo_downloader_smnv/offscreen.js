import { createDateManager } from './date-manager.js';
import { vkSourceDates, ydSourceDates } from './source-dates.js';
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
const dates = createDateManager({ getDirectory: portable.logDirectory, getRoot: portable.logDirectory,
  readLocal: async path => {
    let dir = await portable.logDirectory();
    const parts = path.split('/');
    if (!['yandex-disk', 'vk-messeger'].includes(parts[0]) || parts.some(p => !p || p === '.' || p === '..' || /[\\:]/.test(p))) throw new Error('Некорректный путь.');
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return (await dir.getFileHandle(parts.at(-1))).getFile();
  },
  resolveDate: async (job, file, signal) => {
    if (job.provider === 'vk') await vk.getDates(job, file, signal);
    else await datedResource(job, file.path, 0, signal);
  }
});
async function datedResource(job, ...args) {
  const value = await resource(job, ...args);
  await dates.capture(job, ydSourceDates(value));
  return value;
}
const vk = createVkProvider({ sleep: backgroundSleep, captureDates: (job, items) => dates.capture(job, vkSourceDates(items)) });
const runner = createQueue({ loadEntries: portable.loadEntries, saveEntry: portable.saveEntry, deleteEntry: portable.deleteEntry,
  loadHistory: portable.loadHistory, saveHistory: portable.saveHistory, loadSettings: portable.loadSettings, saveSettings: portable.saveSettings,
  prepareDownloads: async () => portable.prepare(await selectedFolder),
  changeFolder: async token => {
    const handle = await requireFolder(await cache.loadFolderCandidate(token));
    const restored = await portable.changeFolder(handle);
    await cache.saveDownloadFolder(handle); selectedFolder = Promise.resolve(handle); dates.reset();
    return restored;
  },
  findLocal: async (job, file) => findLocalFiles(await portable.logDirectory(), job, file, dates.receipt),
  saveLocal: async (path, source, options) => saveLocalFile(await portable.logDirectory(), path, source, options),
  verifyLocal: async record => verifyLocalRecord(await portable.logDirectory(), record),
  afterSave: dates.afterSave, preparePhoto: dates.prepare, onDiscovered: dates.discovered,
  onActivityChange: active => { if (busy !== active) activity(active); },
  // Short polling delays run in the service worker, not a throttled hidden page.
  sleep: backgroundSleep,
  resource: datedResource, vk, getPhoto: (job, ...args) => job.provider === 'vk' ? vk.getPhoto(job, ...args) : getPhoto(job, ...args),
  getOriginalUrl: (job, ...args) => job.provider === 'vk' ? vk.getOriginalUrl(job, ...args) : originalUrl(job, ...args), downloads: {
  download: args => downloadApi('download', args), search: args => downloadApi('search', args), cancel: id => downloadApi('cancel', id),
  removeFile: id => downloadApi('removeFile', id),
  discardInvalid: args => downloadApi('discardInvalid', args)
} });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'runner') return;
  if (message.action === 'activity') { runner.heartbeat(); respond({ ok: true, value: busy }); return; }
  command(message.action, message.args).then(
    value => respond({ ok: true, value: { ...value, ...((portable.error || portable.warning) ? { notice: portable.error?.message || portable.warning } : {}) } }), error => respond({ ok: false, error: error.message })
  );
  return true;
});

// Commands are serialized without blocking status polling.
// Keep the UI responsive and do not change download counters or pagination.
let commands = Promise.resolve();
function command(action, args) {
  const run = async () => {
    if (action === 'datesStatus') return dates.snapshot();
    const value = await runner.command(action, args);
    return { ...value, dates: dates.snapshot() };
  };
  if (['status', 'datesStatus'].includes(action)) return run();
  const result = commands.catch(() => {}).then(run); commands = result; return result;
}
