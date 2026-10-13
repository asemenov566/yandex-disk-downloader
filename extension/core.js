export const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
export const PAGE_SIZE = 200;

export function parseLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Вставьте публичную ссылку на Яндекс Диск.'); }
  if (url.protocol !== 'https:' || !['disk.yandex.ru', 'disk.yandex.com', 'yadi.sk'].includes(url.hostname)) {
    throw new Error('Нужна ссылка https://disk.yandex.ru/d/… или /i/…');
  }
  const match = url.pathname.match(/^\/(d|i)\/([^/]+)(\/.*)?$/);
  if (!match) throw new Error('Нужна публичная ссылка. Личный раздел /client/disk не поддерживается.');
  const path = match[3] ? decodeURIComponent(match[3]) : '/';
  if (path.split('/').some(part => part === '..' || part === '.') || path.includes('\0')) throw new Error('Некорректный путь в ссылке.');
  return { publicUrl: `${url.origin}/${match[1]}/${match[2]}`, path };
}

export function shortHash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function safeName(name) {
  const original = String(name || 'Без названия');
  let clean = original.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').replace(/^\.+$/, '_');
  if (!clean) clean = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean)) clean = '_' + clean;
  if (clean.length > 120) clean = clean.slice(0, 100) + '-' + shortHash(original) + (original.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '');
  return clean;
}

export function classify(resource) {
  if (resource.type === 'dir') return 'directory';
  if (resource.media_type === 'video' || resource.mime_type?.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm|mts|m2ts|3gp|wmv|m4v|mpg|mpeg)$/i.test(resource.name)) return 'video';
  if (resource.media_type === 'image' || resource.mime_type?.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif|dng|nef|cr2|cr3|arw|orf|rw2)$/i.test(resource.name)) return 'photo';
  return 'other';
}

export function newJob(link, mode = 'auto', { deduplicate = false } = {}) {
  if (!['auto', 'original', 'preview'].includes(mode)) throw new Error('Неизвестный режим качества.');
  return { ...parseLink(link), version: 2, mode, deduplicate: !!deduplicate, title: '', folder: '', phase: 'scanning', pages: 0,
    directories: [{ path: parseLink(link).path, local: '', offset: 0, state: 'pending', root: true }],
    files: [], usedPaths: {}, originalFailures: 0, usePreviews: mode === 'preview', created: new Date().toISOString() };
}

function allocate(job, parent, name, remotePath) {
  let segment = safeName(name);
  let path = [parent, segment].filter(Boolean).join('/');
  const key = path.toLocaleLowerCase('en-US');
  if (Object.hasOwn(job.usedPaths, key) && job.usedPaths[key] !== remotePath) {
    const ext = segment.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '';
    segment = segment.slice(0, segment.length - ext.length) + '-' + shortHash(remotePath) + ext;
    path = [parent, segment].filter(Boolean).join('/');
  }
  Object.defineProperty(job.usedPaths, path.toLocaleLowerCase('en-US'), { value: remotePath, enumerable: true, configurable: true, writable: true });
  return path;
}

function addResource(job, resource, parent) {
  if (!resource.path || !resource.name) throw new Error('API вернул файл без имени или пути.');
  const kind = classify(resource);
  if (kind === 'directory') {
    if (!job.directories.some(d => d.path === resource.path)) {
      job.directories.push({ path: resource.path, local: allocate(job, parent, resource.name, resource.path), offset: 0, state: 'pending' });
    }
    return;
  }
  if (job.files.some(f => f.path === resource.path)) return;
  job.files.push({ path: resource.path, name: resource.name, local: allocate(job, parent, resource.name, resource.path),
    kind, size: resource.size, sha256: resource.sha256, modified: resource.modified, mime: resource.mime_type,
    state: resource.size !== 0 ? 'pending' : 'skipped',
    reason: resource.size === 0 ? 'Пустой файл' : '' });
}

export function consumePage(job, directory, resource) {
  if (directory.root && !job.title) {
    job.title = resource.name || 'Альбом';
    const parents = job.rootTitle ? job.path.split('/').filter(Boolean) : [];
    if (resource.type === 'file') parents.pop();
    job.folder = ['yandex-disk', safeName(job.rootTitle || job.title), ...parents.map(safeName)].join('/');
  }
  if (resource.type === 'file') {
    addResource(job, resource, directory.local);
    directory.state = 'done';
  } else {
    const embedded = resource._embedded;
    if (!embedded || !Array.isArray(embedded.items) || !Number.isInteger(embedded.total) || embedded.total < 0) {
      throw new Error('Неполный список файлов в ответе Яндекса.');
    }
    if (embedded.offset !== undefined && embedded.offset !== directory.offset) throw new Error('Яндекс вернул другую страницу списка.');
    if (!embedded.items.length && directory.offset < embedded.total) throw new Error('Пустая страница до конца списка. Повторите сканирование.');
    for (const item of embedded.items) addResource(job, item, directory.local);
    // Use the actual number returned: servers can return fewer than the requested limit.
    directory.offset += embedded.items.length;
    if (directory.offset >= embedded.total) directory.state = 'done';
  }
  job.pages++;
  if (!job.directories.some(d => d.state === 'pending')) job.phase = 'ready';
}

export function summary(job) {
  if (!job) return null;
  const count = state => job.files.filter(f => f.state === state).length;
  return { total: job.files.length, photos: job.files.filter(f => f.kind === 'photo').length,
    done: count('done'), pending: count('pending') + count('active'), skipped: count('skipped'), failed: count('failed'),
    reused: job.files.filter(f => f.state === 'done' && f.reused).length,
    originals: job.files.filter(f => f.state === 'done' && f.savedKind === 'original').length,
    previews: job.files.filter(f => f.state === 'done' && f.savedKind === 'preview').length,
    directoriesFailed: job.directories.filter(d => d.state === 'failed').length };
}

export function report(job) {
  const quote = v => {
    let text = String(v ?? '');
    if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const rows = [['Путь на Диске', 'Результат', 'Качество', 'Сохранённый файл', 'Ошибка / причина']];
  for (const file of job.files) rows.push([file.path, file.state, file.savedKind || '', file.savedPath || '', file.reason || '']);
  for (const dir of job.directories.filter(d => d.state === 'failed')) rows.push([dir.path, 'failed_directory', '', '', dir.reason]);
  return '\ufeff' + rows.map(row => row.map(quote).join(';')).join('\r\n');
}

export function mediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !(url.hostname === 'downloader.disk.yandex.ru' || url.hostname.endsWith('.storage.yandex.net'))) throw new Error('Неожиданный адрес файла в ответе Яндекса.');
  return url.href;
}

export function outputPath(job, file, kind, mime) {
  let relative = file.local;
  if (kind === 'preview') {
    const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[mime.split(';')[0]] || '.jpg';
    const basename = relative.replace(/\.[^/.]+$/, '');
    // Keep preview copies visibly distinct from originals and avoid mixed extensions.
    relative = basename + '.preview' + extension;
  }
  return job.folder + '/' + relative;
}
