import { createQueue } from './queue.js';
import { resource, getPhoto, originalUrl } from './network.js';
import { loadEntries, saveEntry, deleteEntry, loadHistory, saveHistory } from './storage.js';

async function downloadApi(method, args) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'download-api', method,
    ...(method === 'download' ? { args } : { id: typeof args === 'number' ? args : args.id, expectedSize: args?.expectedSize }) });
  if (!response?.ok) throw new Error(response?.error || 'Chrome не ответил на запрос загрузки.');
  return response.value;
}
const runner = createQueue({ loadEntries, saveEntry, deleteEntry, loadHistory, saveHistory, resource, getPhoto, getOriginalUrl: originalUrl, downloads: {
  download: args => downloadApi('download', args), search: args => downloadApi('search', args), cancel: id => downloadApi('cancel', id),
  removeFile: id => downloadApi('removeFile', id),
  discardInvalid: args => downloadApi('discardInvalid', args)
} });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'runner') return;
  runner.command(message.action, message.args).then(
    value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message })
  );
  return true;
});
