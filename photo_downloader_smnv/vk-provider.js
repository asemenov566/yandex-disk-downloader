import { createVkApiQueue } from './vk-api-queue.js';
import { NOT_FOUND_COOLDOWN } from './retry.js';
import { trace, errorInfo } from './logging.js';
import { inspectVkPage, vkMediaUrl, vkVideoUrl, photoResource, videoResource, allowedVkVideo, stampVkLinks } from './vk.js';
import { fetchPhoto } from './network.js';
import { waitFor } from './wait.js';

export function createVkProvider({ send = message => chrome.runtime.sendMessage(message), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  fetchImage = fetchPhoto, captureDates = async () => {}, now = Date.now } = {}) {
  const tabs = new Map();
  const api = createVkApiQueue(), refreshed = new WeakMap(), fileIndexes = new WeakMap();
  let refreshGeneration = 0;
  const recoveries = new Map(), epochs = new Map();
  const recoveryLanes = [createVkApiQueue(), createVkApiQueue()];
  let recoveryLane = 0, requestId = 0;
  async function delay(ms, signal) {
    // The offscreen worker's background timer accepts at most 1000 ms.
    for (let left = ms; left > 0; left -= 500) {
      signal?.throwIfAborted();
      await waitFor(sleep(Math.min(500, left)), { signal });
    }
  }
  async function rawRequest(job, action, cursor, signal, mediaType, recover = false) {
    signal?.throwIfAborted();
    const response = await waitFor(send({ target: 'background', type: 'vk-api', action,
      link: job.publicUrl, tabId: tabs.get(job.publicUrl), cursor, mediaType, startCmid: job.vkStartCmid, recover, deferRecovery: action !== 'recover' }), { signal, timeout: 75000, message: 'Вкладка ВК не ответила после ожидания восстановления.' });
    if (!response?.ok) throw new Error(response?.error || 'Обработчик ВК недоступен.');
    const result = response.value;
    if (Number.isInteger(result?.tabId)) tabs.set(job.publicUrl, result.tabId);
    if (!result?.ok) throw Object.assign(new Error(result?.error || 'ВК не ответил.'), {
      vkSession: !!result?.vkSession, retryable: !!result?.retryable, status: result?.status,
      recoverable: !!result?.recoverable, recoveryAttempted: !!result?.recoveryAttempted, reloadRequired: result?.reloadRequired
    });
    tabs.set(job.publicUrl, result.tabId);
    // Backfill viewer keys on any metadata response, including date-only lookups.
    if (result.value?.items && job.files?.length) {
      const keys = new Map(result.value.items.flatMap(item => {
        const photo = item.attachment?.photo;
        return photo && /^[a-f0-9]{1,128}$/i.test(photo.access_key || '')
          ? [['/photo' + photo.owner_id + '_' + photo.id, photo.access_key]] : [];
      }));
      for (const file of job.files) if (file.vk && keys.has(file.path)) file.vk.accessKey = keys.get(file.path);
    }
    if (result.value?.items) await captureDates(job, result.value.items);
    return result.value;
  }
  async function recoverTab(job, signal, reload) {
    const key = job.publicUrl;
    if (recoveries.has(key)) return waitFor(recoveries.get(key), { signal, timeout: null });
    const lane = recoveryLanes[recoveryLane++ % recoveryLanes.length], queuedAt = now();
    const pending = lane.run(async () => {
      const started = now();
      trace('vk.recover.start', { session: job.title, ms: started - queuedAt, reason: reload ? 'reload' : 'loading' });
      try {
        await rawRequest(job, 'recover', null, signal, 'photo', reload);
        epochs.set(key, (epochs.get(key) || 0) + 1);
        trace('vk.recover.end', { session: job.title, ms: now() - started });
      } catch (error) {
        trace('vk.recover.error', { session: job.title, ms: now() - started, ...errorInfo(error) }); throw error;
      }
    }, { key, signal });
    recoveries.set(key, pending);
    try { return await pending; } finally { if (recoveries.get(key) === pending) recoveries.delete(key); }
  }
  async function request(job, action, cursor, signal, mediaType = 'photo', onStatus = () => {}, cache = {}) {
    const epoch = epochs.get(job.publicUrl) || 0;
    try { return await queuedRequest(job, action, cursor, signal, mediaType, onStatus, cache); }
    catch (error) {
      signal?.throwIfAborted();
      if (!error.recoverable || error.recoveryAttempted) throw error;
      trace('vk.recover', { session: job.title, action, tabId: tabs.get(job.publicUrl) });
      onStatus('ВК: ждём восстановления вкладки');
      if ((epochs.get(job.publicUrl) || 0) === epoch) await recoverTab(job, signal, error.reloadRequired !== false);
      signal?.throwIfAborted();
      return queuedRequest(job, action, cursor, signal, mediaType, onStatus, cache);
    }
  }
  function queuedRequest(job, action, cursor, signal, mediaType = 'photo', onStatus = () => {}, cache = {}) {
    const id = ++requestId, queuedAt = now();
    return api.run(async () => {
      if (cache.isFresh?.()) {
        trace('vk.request.cached', { session: job.title, requestId: id, action, ms: now() - queuedAt });
        return;
      }
      await delay(1000, signal);
      onStatus('ВК: получаем данные ' + (action === 'page' ? 'следующей порции' : 'файла'));
      const startedAt = now();
      trace('vk.request.start', { session: job.title, requestId: id, action, kind: mediaType, ms: startedAt - queuedAt });
      try {
        const value = await rawRequest(job, action, cursor, signal, mediaType);
        cache.accept?.(value);
        trace('vk.request.end', { session: job.title, requestId: id, action, files: value.items?.length, ms: now() - startedAt });
        return value;
      } catch (error) {
        trace('vk.request.error', { session: job.title, requestId: id, action, ms: now() - startedAt, ...errorInfo(error) }); throw error;
      }
    }, { key: job.publicUrl, refresh: action === 'photo', signal,
      onWaiting: () => {
        onStatus('ждём места в очереди обновления ссылок ВК');
        trace('vk.refresh.wait', { session: job.title, requestId: id, queueDepth: api.waiting });
      },
      onAdmitted: () => {
        onStatus('ждём очередь запросов ВК');
        trace('vk.queued', { session: job.title, requestId: id, action, kind: mediaType, queueDepth: api.depth,
          cmid: cursor?.cmid, position: cursor?.position });
      }
    });
  }

  async function retry(work, signal, onNotice = () => {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await work(); }
      catch (error) {
        signal?.throwIfAborted();
        if (!(error.retryable || error.vkStalled) || attempt >= 3) throw error;
        const seconds = [2, 5, 10][attempt];
        onNotice(`ВК временно не отдаёт следующую порцию. Повтор через ${seconds} с (${attempt + 1}/3)…`);
        await delay(seconds * 1000, signal);
      }
    }
  }
  async function refreshFile(job, file, kind, signal, onStatus, wait = work => work(), notFound = false) {
    const previousRefresh = refreshed.get(file), oldUrl = file.vk?.[kind]?.url;
    const age = previousRefresh ? now() - previousRefresh.at : Infinity;
    const cacheMs = notFound ? NOT_FOUND_COOLDOWN : 30000;
    if (oldUrl && previousRefresh?.urls[kind] === oldUrl && age >= 0 && age < cacheMs) {
      trace('vk.link.refresh.skip', { session: job.title, file: job.files.indexOf(file), reason: notFound ? 'recent-metadata-404' : 'cooldown' });
      return false;
    }
    const mediaType = file.kind === 'video' ? 'video' : 'photo';
    trace('vk.link.refresh.start', { session: job.title, file: job.files.indexOf(file), kind });
    const generation = previousRefresh?.generation || 0;
    const isFresh = () => (refreshed.get(file)?.generation || 0) > generation;
    const accept = fresh => {
      let index = fileIndexes.get(job);
      if (!index || index.files !== job.files || index.length !== job.files.length) {
        index = { files: job.files, length: job.files.length, byPath: new Map(job.files.map(item => [item.path, item])) };
        fileIndexes.set(job, index);
      }
      // Resolve by exact media identity, never by array position. This refresh
      // only updates known files; discovering files/cursors belongs to nextPage.
      const items = (fresh.items || []).slice(0, 30), updates = [];
      let targetFound = false;
      for (const item of items) {
        const media = item.attachment?.[mediaType];
        if (!media) continue;
        const path = '/' + mediaType + media.owner_id + '_' + media.id;
        const known = path === file.path ? file : index.byPath.get(path);
        if (!known || known.kind !== mediaType) continue;
        try {
          const next = (mediaType === 'video' ? videoResource(item) : photoResource(item)).vk;
          updates.push([known, next]); if (known === file) targetFound = true;
        } catch (error) { if (known === file) throw error; }
      }
      if (!targetFound) throw new Error('ВК больше не возвращает этот файл.');
      const at = now(), generation = ++refreshGeneration;
      for (const [known, next] of updates) {
        stampVkLinks(next, known.vk); known.vk = next;
        refreshed.set(known, { at, generation, urls: Object.fromEntries(['original', 'preview', 'video'].map(kind => [kind, next[kind]?.url])) });
      }
      trace('vk.link.refresh.batch', { session: job.title, kind: mediaType, files: updates.length });
    };
    await wait(() => retry(() => request(job, 'photo', { cmid: file.vk.cmid, position: file.vk.position }, signal, mediaType, onStatus,
      { isFresh, accept }), signal, onStatus));
    const changed = oldUrl !== file.vk?.[kind]?.url;
    trace('vk.link.refresh.end', { session: job.title, file: job.files.indexOf(file), kind, changed });
    return changed;
  }
  return {
    async getDates(job, file, signal) {
      if (!file.vk?.cmid) throw new Error('Нет позиции вложения для получения даты.');
      await request(job, 'photo', { cmid: file.vk.cmid, position: file.vk.position }, signal, file.kind === 'video' ? 'video' : 'photo');
    },
    prepare: (job, signal) => request(job, 'prepare', null, signal),
    async nextPage(job, signal, onNotice, directory = job.directories[0], pageDelayMs = 1000) {
      const mediaType = directory.mediaType || 'photo';
      const cursor = directory.cursor || (mediaType === 'photo' ? job.vkCursor : null);
      const read = () => retry(async () => {
        const result = await request(job, 'page', cursor, signal, mediaType, text => onNotice?.('ВК: ' + (mediaType === 'photo' ? 'фотографии' : 'видео') + ' · ' + text));
        const page = inspectVkPage(result, cursor, mediaType);
        if (Number.isSafeInteger(result.startCmid) && result.startCmid >= 0) job.vkStartCmid ??= result.startCmid;
        return page;
      }, signal, onNotice);
      trace('vk.page.delay', { session: job.title, kind: mediaType, ms: pageDelayMs });
      onNotice?.('ВК: ' + (mediaType === 'photo' ? 'фотографии' : 'видео') + ' · следующая порция через ' + pageDelayMs / 1000 + ' с');
      await delay(pageDelayMs, signal);
      const first = await read();
      if (!first.empty) return first;
      // A short/empty page can be a temporary VK glitch. Confirm the end using
      // the same cursor, never use fewer than count=30 as an end marker.
      onNotice?.('ВК вернул пустую страницу. Проверяем окончание списка…');
      await delay(2500, signal);
      return read();
    },
    async getOriginalUrl(job, file, signal, refresh = false, onStatus = () => {}, wait = work => work(), { notFound = false } = {}) {
      if (!allowedVkVideo(file) || file.vk?.external) throw new Error('Видео не соответствует фильтру «Видео от» и хостинга ВК.');
      if (refresh || !file.vk?.video?.url) {
        await refreshFile(job, file, 'video', signal, onStatus, wait, notFound);
      }
      if (!allowedVkVideo(file) || file.vk?.external) throw new Error('Название или источник видео изменились; файл не скачан.');
      if (!file.vk?.video?.url) throw new Error('ВК не предоставил прямой MP4-файл. Ссылка на плеер или HLS/DASH не сохраняется как видео.');
      return vkVideoUrl(file.vk.video.url);
    },
    async getPreviewFallback(job, file, signal, onProgress, timeoutMs, onStatus = () => {}, { wait = work => work(), runRequest = work => work() } = {}) {
      const seen = new Set([file.vk?.preview?.url]);
      const variants = (file.vk?.previews || []).filter(source => {
        if (!source?.url || seen.has(source.url)) return false;
        seen.add(source.url); return true;
      }).sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0));
      for (const source of variants) {
        signal.throwIfAborted();
        try {
          const blob = await runRequest(() => this.getPhoto(job, file, 'preview', signal, onProgress, timeoutMs,
            onStatus, { sourceOverride: source, skipRefresh: true }), { signal, wait, onStatus });
          file.vk.preview = source;
          trace('vk.preview.selected', { session: job.title, file: job.files.indexOf(file), width: source.width, height: source.height });
          return blob;
        } catch (error) {
          signal.throwIfAborted();
          // Rate limits, network failures and cancellation are not evidence that
          // a smaller image works. Never multiply these errors across variants.
          if (![403, 404, 410].includes(error.status)) throw error;
        }
      }
      return null;
    },
    async getPhoto(job, file, kind, signal, onProgress, timeoutMs, onStatus = () => {}, { refresh404 = false, wait = work => work(), sourceOverride = null, skipRefresh = false } = {}) {
      const read = async () => {
        onStatus(sourceOverride ? 'пробуем копию ' + sourceOverride.width + '×' + sourceOverride.height : kind === 'original' ? 'получаем оригинал' : 'получаем копию');
        const source = sourceOverride || file.vk?.[kind === 'original' ? 'original' : 'preview'];
        if (!source?.url) throw new Error(kind === 'original' ? 'ВК не предоставил оригинал фотографии.' : 'ВК не предоставил превью фотографии.');
        // VK does not report bytes. Always decode photos; never accept an error body.
        const started = now(), host = new URL(vkMediaUrl(source.url)).hostname;
        const fields = { session: job.title, file: job.files.indexOf(file), kind, host };
        const linkAge = () => Number.isFinite(source.receivedAt) ? Math.max(0, now() - source.receivedAt) : undefined;
        trace('http.photo.start', { ...fields, ms: timeoutMs, linkAgeMs: linkAge() });
        try {
          const blob = await fetchImage(vkMediaUrl(source.url), { ...file, size: undefined, mime: 'image/jpeg' }, kind, signal, onProgress, timeoutMs);
          trace('http.photo.end', { ...fields, ms: now() - started, bytes: blob.size, linkAgeMs: linkAge() }); return blob;
        } catch (error) { trace('http.photo.error', { ...fields, ms: now() - started, linkAgeMs: linkAge(), ...errorInfo(error) }); throw error; }
      };
      try { return await read(); }
      catch (error) {
        signal.throwIfAborted();
        if (skipRefresh || ![401, 403, 404, 410].includes(error.status)) throw error;
        if (error.status === 404 && !refresh404) throw error;
        const changed = await refreshFile(job, file, kind === 'original' ? 'original' : 'preview', signal, onStatus, wait, error.status === 404);
        if (error.status === 404 && !changed) throw error;
        return read();
      }
    }
  };
}
