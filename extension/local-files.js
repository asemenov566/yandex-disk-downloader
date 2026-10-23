import { outputPath } from './core.js';
import { mediaUrl } from './core.js';
import { waitFor, dataTimeoutError } from './wait.js';
import { vkVideoUrl } from './vk.js';

export function folderAccessError() {
  return Object.assign(new Error('Chrome не разрешает доступ к сохранённой папке. Подтвердите доступ в настройках расширения. Скачивание приостановлено.'), { localAccess: true });
}

export async function requireFolder(handle) {
  if (!handle) throw Object.assign(new Error('Выберите папку загрузок в настройках.'), { localAccess: true });
  try {
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw folderAccessError();
  } catch { throw folderAccessError(); }
  return handle;
}

function pathParts(root, relative) {
  const parts = relative.split('/');
  if (!['yandex-disk', 'vk-messager'].includes(parts[0]) || parts.some(p => !p || p === '.' || p === '..' || /[\\:]/.test(p))) throw new Error('Некорректный путь сохранения.');
  return parts;
}

async function lookup(root, relative, kind, validateImage = false, validateVideo = false) {
  const parts = pathParts(root, relative);
  let dir = root;
  try {
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(parts.at(-1));
    const file = await handle.getFile();
    if (validateImage) {
      let bitmap;
      try { bitmap = await createImageBitmap(file); }
      catch { throw new Error('Файл уже есть, но не читается как фотография: ' + relative); }
      bitmap.close();
    }
    if (validateVideo) {
      const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') throw new Error('Файл уже есть, но не является MP4: ' + relative);
    }
    return { savedKind: kind, savedBytes: file.size, savedPath: relative, localFile: true };
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') throw folderAccessError();
    throw error;
  }
}

// Read the selected directory on every attempt. This also works with a fresh
// extension database, copied files, and an empty Chrome downloads history.
export async function findLocalFiles(root, job, file) {
  await requireFolder(root);
  const original = await lookup(root, outputPath(job, file, 'original', ''), 'original', job.provider === 'vk' && file.kind === 'photo', job.provider === 'vk' && file.kind === 'video');
  if (original) {
    if (job.provider === 'vk' ? !original.savedBytes : (!Number.isFinite(file.size) || original.savedBytes !== file.size)) {
      throw new Error('Файл уже есть в папке, но его размер не совпадает с размером на Диске. Повторная копия не создаётся: ' + original.savedPath);
    }
    return { original, preview: null };
  }
  if (file.kind === 'photo') {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      const preview = await lookup(root, outputPath(job, file, 'preview', mime), 'preview');
      if (preview) {
        if (!preview.savedBytes) throw new Error('В папке есть пустое preview. Проверьте файл: ' + preview.savedPath);
        return { original: null, preview };
      }
    }
  }
  return { original: null, preview: null };
}

export async function verifyLocalRecord(root, record) {
  await requireFolder(root);
  // Old Chrome receipts can point outside the newly selected directory.
  if (!record.localFile) return null;
  const local = await lookup(root, record.savedPath, record.savedKind);
  return local?.savedBytes === record.savedBytes ? local : null;
}

// Stream large originals directly to the chosen directory. createWritable commits
// on close; failure/abort discards partial data, never a user's existing file.
export async function saveLocalFile(root, relative, source, { signal, expectedSize, direct = false,
  onProgress = () => {}, fetcher = fetch, timeout = 25000 } = {}) {
  await requireFolder(root);
  signal?.throwIfAborted();
  const parts = pathParts(root, relative);
  let dir = root;
  try {
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  } catch (error) {
    if (['NotAllowedError', 'SecurityError', 'NotFoundError'].includes(error.name)) throw folderAccessError();
    throw error;
  }
  const name = parts.at(-1);
  try {
    await dir.getFileHandle(name);
    throw new Error('Файл уже появился в папке. Повторите попытку, чтобы проверить его: ' + relative);
  } catch (error) { if (error.name !== 'NotFoundError') throw error; }
  let handle, writable, reader, committed = false;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const bounded = promise => waitFor(promise, { signal: combined, timeout, timeoutError: dataTimeoutError(timeout) });
  const vkVideo = direct && relative.startsWith('vk-messager/') && relative.endsWith('.mp4');
  let transferSize = expectedSize;
  const header = [];
  try {
    let stream;
    if (direct) {
      const response = await bounded(fetcher(vkVideo ? vkVideoUrl(source) : mediaUrl(source), { credentials: 'omit', signal: combined }));
      if (!response.ok) throw Object.assign(new Error('Файловый сервер: HTTP ' + response.status), { status: response.status });
      if (vkVideo) {
        if (response.url) vkVideoUrl(response.url);
        if (/text\/|json|html|mpegurl|dash\+xml/i.test(response.headers.get('content-type') || '')) throw new Error('Вместо MP4 сервер вернул страницу или плейлист.');
        const length = Number(response.headers.get('content-length'));
        if (!Number.isFinite(transferSize) && Number.isSafeInteger(length) && length > 0 && !response.headers.get('content-encoding')) transferSize = length;
      }
      stream = response.body;
    } else stream = source.stream();
    reader = stream.getReader();
    combined.throwIfAborted();
    // The HTTP request may have taken seconds. Check again in case another
    // application placed the file there while we were waiting for the server.
    try {
      await dir.getFileHandle(name);
      throw new Error('Файл уже появился в папке. Повторите попытку, чтобы проверить его: ' + relative);
    } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    handle = await dir.getFileHandle(name, { create: true });
    if ((await handle.getFile()).size !== 0) throw new Error('Файл уже появился в папке: ' + relative);
    writable = await handle.createWritable();
    let bytes = 0;
    while (true) {
      const { value, done } = await bounded(reader.read());
      if (done) break;
      bytes += value.byteLength;
      if (vkVideo && header.length < 12) header.push(...value.subarray(0, 12 - header.length));
      if (Number.isFinite(transferSize) && bytes > transferSize) throw new Error('Размер скачанного файла не совпадает с ожидаемым.');
      await writable.write(value);
      combined.throwIfAborted();
      onProgress(bytes);
    }
    if (Number.isFinite(transferSize) && bytes !== transferSize) throw new Error('Размер скачанного файла не совпадает с ожидаемым.');
    if (vkVideo && (header.length < 12 || String.fromCharCode(...header.slice(4, 8)) !== 'ftyp')) throw new Error('Сервер не вернул MP4-видео.');
    combined.throwIfAborted();
    await writable.close(); committed = true;
    return { savedPath: relative, savedBytes: bytes, localFile: true };
  } catch (error) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') throw folderAccessError();
    throw error;
  } finally {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    if (!committed && handle) {
      if (writable) await writable.abort().catch(() => {});
      // Only the empty placeholder created by this attempt may be removed.
      if ((await handle.getFile().catch(() => null))?.size === 0) await dir.removeEntry(name).catch(() => {});
    }
  }
}
