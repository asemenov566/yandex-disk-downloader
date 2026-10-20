import { outputPath } from './core.js';
import { mediaUrl } from './core.js';
import { waitFor } from './wait.js';

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
  if (parts[0] !== 'yandex-disk' || parts.some(p => !p || p === '.' || p === '..' || /[\\:]/.test(p))) throw new Error('Некорректный путь сохранения.');
  return parts;
}

async function lookup(root, relative, kind) {
  const parts = pathParts(root, relative);
  let dir = root;
  try {
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(parts.at(-1));
    const file = await handle.getFile();
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
  const original = await lookup(root, outputPath(job, file, 'original', ''), 'original');
  if (original) {
    if (!Number.isFinite(file.size) || original.savedBytes !== file.size) {
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
  const bounded = promise => waitFor(promise, { signal: combined, timeout, message: `Нет данных от файлового сервера ${timeout / 1000} с.` });
  try {
    let stream;
    if (direct) {
      const response = await bounded(fetcher(mediaUrl(source), { credentials: 'omit', signal: combined }));
      if (!response.ok) throw Object.assign(new Error('Файловый сервер: HTTP ' + response.status), { status: response.status });
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
      if (Number.isFinite(expectedSize) && bytes > expectedSize) throw new Error('Размер скачанного файла не совпадает с размером на Диске.');
      await writable.write(value);
      combined.throwIfAborted();
      onProgress(bytes);
    }
    if (Number.isFinite(expectedSize) && bytes !== expectedSize) throw new Error('Размер скачанного файла не совпадает с размером на Диске.');
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
