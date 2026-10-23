// VK's current messenger pagination: the last attachment's cmid + position,
// not a DOM scroll offset. No credentials belong in jobs or portable storage.
export function parseVkLink(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  if (url.protocol !== 'https:' || !['vk.ru', 'vk.com', 'www.vk.ru', 'www.vk.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
  let peer = url.pathname.match(/^\/im\/convo\/(-?\d+)\/?$/)?.[1];
  if (!peer && /^\/im\/?$/.test(url.pathname)) {
    const selected = url.searchParams.get('sel');
    if (/^-?\d+$/.test(selected || '')) peer = selected;
    else if (/^c\d+$/.test(selected || '')) peer = String(2000000000 + Number(selected.slice(1)));
  }
  if (!peer || !Number.isSafeInteger(Number(peer)) || Number(peer) === 0) return null;
  return { provider: 'vk', peerId: Number(peer), publicUrl: `https://vk.ru/im/convo/${Number(peer)}`, path: '/' };
}

export function vkMediaUrl(value) {
  const url = new URL(value);
  const domains = ['vkuserphoto.ru', 'vkuserphoto.com', 'userapi.com', 'vkusercontent.ru'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !domains.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
    throw new Error('ВК вернул неизвестный адрес фотографии.');
  }
  return url.href;
}

export function vkVideoUrl(value) {
  const url = new URL(value);
  const domains = ['okcdn.ru', 'vkuser.net', 'userapi.com', 'vkusercontent.ru'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !domains.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('ВК вернул неизвестный адрес видео.');
  return url.href;
}

export function vkPhotosLink(value) {
  const source = parseVkLink(value);
  if (!source) throw new Error('Нужна ссылка на диалог ВК.');
  // The shared peer panel contains both photo and video tabs.
  return `${source.publicUrl}?rp=peer${source.peerId}`;
}

export function ensureVkDirectories(job) {
  if (job.provider !== 'vk') return job;
  const photos = job.directories[0];
  photos.mediaType = 'photo';
  photos.cursor ??= job.vkCursor || null;
  if (!job.directories.some(d => d.mediaType === 'video')) {
    job.directories.push({ path: '/videos', local: '', offset: 0, state: 'pending', mediaType: 'video', cursor: null });
    if (job.phase === 'done') job.phase = 'ready';
  }
  return job;
}

export function validCursor(cursor) {
  return !!cursor && Number.isSafeInteger(cursor.cmid) && cursor.cmid > 0 &&
    Number.isSafeInteger(cursor.position) && cursor.position >= 0;
}
export function sameCursor(a, b) { return !!a && !!b && a.cmid === b.cmid && a.position === b.position; }
function older(a, b) { return a.cmid < b.cmid || (a.cmid === b.cmid && a.position < b.position); }

export function photoResource(item) {
  const photo = item?.attachment?.photo;
  if (item?.attachment?.type !== 'photo' || !photo || !Number.isSafeInteger(photo.id) || photo.id <= 0 ||
      !Number.isSafeInteger(photo.owner_id) || !photo.owner_id || !validCursor(item)) {
    throw new Error('ВК вернул неполные данные фотографии. Позиция не изменена.');
  }
  const image = value => value?.url ? { url: vkMediaUrl(value.url), width: value.width, height: value.height } : null;
  const original = image(photo.orig_photo);
  // Never call the largest preview an original when orig_photo is absent.
  const preview = (photo.sizes || []).filter(s => ['s', 'm', 'x', 'y', 'z', 'w', 'base'].includes(s.type) && s.url)
    .sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0)).map(image)[0] || null;
  const id = `photo${photo.owner_id}_${photo.id}`;
  const ext = original && new URL(original.url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[0].toLowerCase() || '.jpg';
  return { path: '/' + id, name: id + ext, local: id + ext, kind: 'photo', state: 'pending',
    vk: { cmid: item.cmid, position: item.position, original, preview }, reason: '' };
}

export function videoResource(item) {
  const video = item?.attachment?.video;
  if (item?.attachment?.type !== 'video' || !video || !Number.isSafeInteger(video.id) || video.id <= 0 ||
      !Number.isSafeInteger(video.owner_id) || !video.owner_id || !validCursor(item)) throw new Error('ВК вернул неполные данные видео. Позиция не изменена.');
  const variants = Object.entries(video.files || {}).filter(([key, value]) => /^mp4_\d+$/.test(key) && typeof value === 'string')
    .flatMap(([key, value]) => { try { return [{ quality: Number(key.slice(4)), url: vkVideoUrl(value) }]; } catch { return []; } })
    .sort((a, b) => b.quality - a.quality);
  const best = variants[0] || null;
  const id = `video${video.owner_id}_${video.id}`;
  return { path: '/' + id, name: id + '.mp4', local: id + '.mp4', kind: 'video', mime: 'video/mp4', state: 'pending',
    vk: { cmid: item.cmid, position: item.position, video: best, external: !!video.files?.external,
      title: typeof video.title === 'string' ? video.title : '' }, reason: '' };
}

export function allowedVkVideo(file) {
  const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  return /(?:^|[^\p{L}\p{N}_])видео от(?=$|[^\p{L}\p{N}_])/u.test(normalize(file.vk?.title));
}

export function filterVkVideos(job) {
  for (const file of job.files) {
    if (file.kind !== 'video' || file.state === 'done' || file.disabledBySetting) continue;
    if (file.vk?.external || !file.vk?.video) {
      file.state = 'skipped'; file.reason = 'Нет прямого MP4 с серверов ВК: внешние плееры и HLS/DASH не скачиваются.';
    } else if (!allowedVkVideo(file)) {
      file.state = 'skipped'; file.reason = 'В названии нет «Видео от».';
    } else if (file.state === 'skipped') { file.state = 'pending'; file.reason = ''; }
  }
}

// Validate a whole response before mutating the persisted cursor/files.
export function inspectVkPage(response, cursor, mediaType = 'photo') {
  if (!['photo', 'video'].includes(mediaType)) throw new Error('Неизвестный тип вложений ВК.');
  if (!response || !Array.isArray(response.items)) throw new Error('ВК не вернул список вложений. Позиция не изменена.');
  if (!response.items.length) return { files: [], cursor, empty: true };
  const files = response.items.map(mediaType === 'video' ? videoResource : photoResource);
  const last = response.items.at(-1);
  const next = { cmid: last.cmid, position: last.position };
  if (cursor && !older(next, cursor)) throw Object.assign(new Error('ВК повторяет страницу вложений. Позиция сохранена; попробуйте продолжить позже.'), { vkStalled: true });
  return { files, cursor: next, empty: false };
}

export function consumeVkPage(job, page, directory = job.directories[0]) {
  const known = new Set(job.files.map(file => file.path));
  const receivedAt = Date.now();
  for (const file of page.files) if (!known.has(file.path)) {
    stampVkLinks(file.vk, null, receivedAt);
    job.files.push(file); known.add(file.path);
  }
  filterVkVideos(job);
  directory.cursor = page.cursor;
  if (directory.mediaType !== 'video') job.vkCursor = page.cursor;
  job.pages++;
  directory.offset += page.files.length;
  if (page.empty) directory.state = 'done';
}

// Timestamp the first API response that supplied this exact media URL. A
// refresh that returns the same URL must not reset its age in diagnostics.
export function stampVkLinks(value, previous = null, at = Date.now()) {
  for (const kind of ['original', 'preview', 'video']) {
    const source = value?.[kind], old = previous?.[kind];
    if (!source?.url) continue;
    source.receivedAt = old?.url === source.url && Number.isFinite(old.receivedAt) ? old.receivedAt : at;
  }
}
