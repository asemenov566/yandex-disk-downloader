let creating;
async function ensureRunner() {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS'],
      justification: 'Download and validate photos, create Blob URLs, and keep the queue independent of the popup.'
    }).finally(() => { creating = null; });
  }
  await creating;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'background') return;
  (async () => {
    if (message.type === 'download-api') {
      if (sender.url !== chrome.runtime.getURL('offscreen.html')) throw new Error('Недопустимый отправитель.');
      if (message.method === 'download') {
        const url = new URL(message.args.url);
        const blob = message.args.url.startsWith('blob:' + chrome.runtime.getURL(''));
        const remote = url.protocol === 'https:' && (url.hostname === 'downloader.disk.yandex.ru' || url.hostname.endsWith('.storage.yandex.net'));
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
