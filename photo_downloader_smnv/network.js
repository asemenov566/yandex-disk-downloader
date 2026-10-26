import { fileHttpError } from './http-errors.js';
import { dataTimeoutError } from './wait.js';
import { deadline } from './deadlines.js';
import { API, PAGE_SIZE, mediaUrl } from './core.js';

export async function resource(job, path, offset = 0, signal) {
  return apiRequest('', { public_key: job.publicUrl, path, offset, limit: PAGE_SIZE, sort: 'name', preview_size: 'XXXL', preview_crop: false }, signal);
}

export async function originalUrl(job, file, signal) {
  const value = (await apiRequest('/download', { public_key: job.publicUrl, path: file.path }, signal)).href;
  if (!value) throw new Error('Яндекс не вернул ссылку на файл.');
  return mediaUrl(value);
}

export async function apiRequest(suffix, params, signal) {
  const response = await fetch(API + suffix + '?' + new URLSearchParams(params), {
    credentials: 'omit', signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])])
  });
  if (!response.ok) {
    const error = new Error(response.status === 429 ? 'Яндекс ограничил частоту запросов (429). Повторите позже.' : `Яндекс: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function getPhoto(job, file, kind, signal, onProgress = () => {}, timeoutMs = 25000) {
  let url;
  if (kind === 'original') {
    url = await originalUrl(job, file, signal);
  } else {
    url = (await resource(job, file.path, 0, signal)).preview;
    if (!url) throw new Error('У фотографии нет доступной копии для просмотра.');
  }
  if (!url) throw new Error('Яндекс не вернул ссылку на файл.');
  return fetchPhoto(mediaUrl(url), file, kind, signal, onProgress, timeoutMs);
}

// The caller validates the provider's media host before using this shared reader.
export async function fetchPhoto(url, file, kind, signal, onProgress = () => {}, timeoutMs = 25000) {
  const timeout = new AbortController();
  let timer;
  const refresh = () => { timer?.(); timer = deadline(() => timeout.abort(dataTimeoutError(timeoutMs)), timeoutMs); };
  refresh();
  try {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.any([...(signal ? [signal] : []), timeout.signal]) });
    if (!response.ok) {
      throw fileHttpError(response);
    }
    const mime = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    if (/text\/|json|html/i.test(mime)) throw new Error('Вместо фотографии сервер вернул текст ошибки.');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      refresh();
      bytes += value.byteLength;
      if (bytes > 512 * 1024 * 1024) { await reader.cancel(); throw new Error('Фото больше 512 МБ: пропущено для защиты памяти браузера.'); }
      chunks.push(value);
      onProgress(bytes);
    }
    if (!bytes) throw new Error('Сервер вернул пустой файл.');
    const blob = new Blob(chunks, { type: mime });
    if (kind === 'original' && Number.isFinite(file.size) && bytes !== file.size) throw new Error('Размер скачанного оригинала не совпадает с размером на Диске.');
    if (kind === 'original' && file.sha256) {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      const hash = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
      if (hash !== file.sha256.toLowerCase()) throw new Error('Контрольная сумма оригинала не совпала.');
    }
    // RAW/TIFF/HEIC originals are not reliably decodable by Chrome; size/hash still apply.
    if (kind === 'preview' || /image\/(jpeg|png|webp|gif|bmp|avif)/i.test(mime + ' ' + file.mime)) {
      let bitmap;
      try { bitmap = await createImageBitmap(blob); }
      catch { throw new Error('Файл не удалось прочитать как изображение: пропущен.'); }
      bitmap.close();
    }
    return blob;
  } finally { timer?.(); }
}
