import { errorInfo } from './logging.js';
import { retryNotFound, NOT_FOUND_DELAYS, createNotFoundPolicy } from './retry.js';
import { newJob, summary, report, outputPath, consumePage, safeName } from './core.js';
import { consumeVkPage, ensureVkDirectories, filterVkVideos } from './vk.js';
import { waitFor, dataTimeoutError } from './wait.js';
import { createDownloadPool } from './pool.js';
import { DOWNLOAD_MODES, mediaTypeForMode, photoQualityForMode, migrateDownloadMode } from './modes.js';
import { issueLink } from './diagnostics-data.js';
import { jobTiming, activeTime } from './timing.js';

export function createRunner({ loadJob, saveJob, resource, getPhoto, getOriginalUrl, downloads, vk,
  loadHistory = async () => ({}), saveHistory = async () => {}, withFileLock = async (_key, work) => work(),
  runFiles = createDownloadPool().run, runVkRequest = work => work(),
  findLocal = async () => null,
  saveLocal, verifyLocal, afterSave = async () => {}, preparePhoto = async (_job, _file, blob) => blob, onDiscovered = async () => {},
  trace = () => {},
  getTimeout = () => 25000, getVkPageDelay = () => 1000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  let job = null, running = false, controller, current = '', notice = '', stopping = false;
  let runPromise = Promise.resolve();
  const transfers = new Map();
  const notFoundPolicy = createNotFoundPolicy({ now });
  function fileProgress(file, text) {
    const previous = transfers.get(file.path), at = now();
    const stage = /МБ/.test(text) ? 'receiving' : text.replace(/\d+/g, '#');
    const log = !previous || previous.stage !== stage || at - previous.loggedAt >= 5000;
    if (log) trace('file.progress', { file: job.files.indexOf(file), kind: file.kind, stage: text });
    transfers.set(file.path, { path: file.path, name: file.name, kind: file.kind, url: issueLink(job, file), status: text, stage,
      slotReleased: previous?.slotReleased || false, changedAt: previous?.status === text ? previous.changedAt : at, loggedAt: log ? at : previous.loggedAt });
    current = file.name + ' · ' + text;
  }
  let timedJob = null, timeInterval = null;
  function updateClock() {
    if (!running || !job) return;
    const at = now();
    if (timedJob !== job) {
      timedJob = job; timeInterval = [at, at];
      if (!Array.isArray(job.timeIntervals)) job.timeIntervals = [];
      job.timeIntervals.push(timeInterval);
    } else timeInterval[1] = Math.max(timeInterval[0], at);
  }
  const checkpoint = async () => {
    updateClock(); const at = now(); trace('state.save.start', { phase: job?.phase });
    try { await saveJob(job); trace('state.save.end', { ms: now() - at }); }
    catch (error) { trace('state.save.error', { ms: now() - at, ...errorInfo(error) }); throw error; }
  };
  const getDownloadType = () => mediaTypeForMode(job.mode);
  const mediaEnabled = kind => getDownloadType() === 'all' || kind === (getDownloadType() === 'photos' ? 'photo' : 'video');
  const directoryEnabled = dir => job.provider !== 'vk' || mediaEnabled(dir.mediaType);
  function syncMediaSettings() {
    if (!job) return;
    const changedType = !!job.downloadType && job.downloadType !== getDownloadType();
    job.downloadType = getDownloadType();
    delete job.videoDisabled;
    for (const file of job.files) {
      if (file.state === 'done') continue;
      const enabled = mediaEnabled(file.kind);
      if (enabled && file.disabledBySetting) {
        delete file.disabledBySetting; file.state = 'pending'; file.reason = '';
      } else if (!enabled && ['pending', 'failed'].includes(file.state)) {
        file.disabledBySetting = true; file.state = 'skipped'; file.reason = 'Пропущено по выбранному типу скачивания.';
      }
    }
    if (job.provider === 'vk') filterVkVideos(job);
    if (job.phase === 'done' && (job.files.some(file => file.state === 'pending') ||
        (changedType && job.directories.some(dir => directoryEnabled(dir) && dir.state === 'pending')))) job.phase = 'ready';
  }
  const countNewFile = () => {
    job.runNewFiles = (Number.isSafeInteger(job.runNewFiles) && job.runNewFiles >= 0 ? job.runNewFiles : 0) + 1;
    job.timingFiles = (Number.isSafeInteger(job.timingFiles) && job.timingFiles >= 0 ? job.timingFiles : 0) + 1;
  };
  const key = file => JSON.stringify([job.publicUrl, file.path]);
  const contentKey = file => /^[a-f0-9]{64}$/i.test(file.sha256 || '') ? JSON.stringify(['content',
    (job.folder + '/' + file.local.split('/').slice(0, -1).join('/')).normalize('NFC').toLowerCase(), file.sha256.toLowerCase()]) : null;
  async function known(file) {
    const primary = await loadHistory(key(file)) || {};
    if (!job.deduplicate || !contentKey(file)) return primary;
    const shared = await loadHistory(contentKey(file)) || {};
    return {
      original: await existing(primary.original, file) ? primary.original : shared.original,
      preview: await existing(primary.preview, file) ? primary.preview : shared.preview
    };
  }
  async function persistHistory(file, history) {
    // Content aliases must not masquerade as a downloaded source entry when the
    // user later turns content deduplication off. Keep receipts for their owner.
    const own = Object.fromEntries(Object.entries(history).filter(([, record]) => record && (!record.sourceKey || record.sourceKey === key(file))));
    await saveHistory(key(file), own);
    if (contentKey(file)) await saveHistory(contentKey(file), history);
  }
  function snapshot({ allIssues = false } = {}) {
    updateClock();
    const counts = job && summary(job);
    const pendingDirectories = job?.directories.filter(d => d.state === 'pending' && directoryEnabled(d)).length || 0;
    const issues = job ? [...job.directories.filter(d => d.state === 'failed'),
      ...job.files.filter(f => ['failed', 'skipped'].includes(f.state) || f.cleanupError)] : [];
    return { running, current, currentUrl: [...transfers.values()].find(f => current.startsWith(f.name + ' · '))?.url || '', notice, job: job ? {
      title: job.title, folder: job.folder, phase: job.phase, pass: job.pass, pages: job.pages, mode: job.mode, provider: job.provider,
      publicUrl: job.publicUrl, path: job.path, deduplicate: !!job.deduplicate, usePreviews: job.usePreviews, summary: counts,
      downloadType: getDownloadType(), pendingDirectories, timing: jobTiming(job, counts, pendingDirectories),
      activeFiles: [...transfers.values()].map(({ path, name, kind, status, url }) => ({ path, name, kind, status, url })),
      issuesTotal: issues.length,
      issues: (allIssues ? issues : issues.slice(-30)).map(f => ({ name: f.name || f.path,
        path: [job.rootTitle || job.title || 'Каталог', ...f.path.split('/').filter(Boolean)].join(' / '),
        reason: f.cleanupError || f.reason, state: f.cleanupError ? 'failed' : f.state,
        url: issueLink(job, f) }))
    } : null };
  }
  function launch(work) {
    trace('session.start');
    transfers.clear(); running = true; stopping = false; controller = new AbortController(); notice = '';
    timedJob = null; timeInterval = null; updateClock();
    runPromise = (async () => {
      try { await work(controller.signal); }
      catch (error) { trace('session.error', errorInfo(error)); notice = controller.signal.aborted && controller.signal.reason?.name === 'AbortError' ? 'Приостановлено. Можно продолжить.' : error.message; }
      finally {
        if (stopping && job) { job.phase = 'stopped'; notice = 'Остановлено. Сохранённые файлы учтём при новом запуске.'; }
        trace('session.end', { phase: job?.phase, total: job?.files.length });
        updateClock(); running = false; current = ''; transfers.clear();
        if (job) await checkpoint().catch(error => { notice = error.message; });
      }
    })();
  }
  async function scan(signal) {
    job.phase = 'scanning';
    if (job.path !== '/' && !job.rootTitle) {
      job.rootTitle = (await resource(job, '/', 0, signal)).name;
      if (!job.rootTitle) throw new Error('Яндекс не вернул название корневой папки.');
      await checkpoint();
    }
    while (job.directories.some(d => d.state === 'pending')) {
      signal.throwIfAborted();
      const dir = job.directories.find(d => d.state === 'pending');
      current = `Список: ${dir.path} · начиная с файла ${dir.offset + 1}`;
      try {
        const start = job.files.length;
        consumePage(job, dir, await resource(job, dir.path, dir.offset, signal));
        await onDiscovered(job, job.files.slice(start));
      }
      catch (error) {
        signal.throwIfAborted();
        if (error.status === 429) throw error;
        dir.state = 'failed'; dir.reason = error.message;
        if (dir.root && !job.title) { await checkpoint(); throw error; }
      }
      await checkpoint();
    }
    job.phase = 'ready'; await checkpoint();
  }
  async function runVk(signal, downloadFiles = true) {
    if (!vk) throw new Error('Обработчик ВК недоступен. Обновите расширение.');
    current = 'Подключаемся к открытому диалогу ВК…';
    trace('vk.prepare.start');
    const info = await vk.prepare(job, signal);
    trace('vk.prepare.end');
    signal.throwIfAborted();
    delete job.vkVideoTitles;
    syncMediaSettings();
    if (!job.title) {
      job.title = info.title;
      job.folder = 'vk-messeger/' + safeName(info.title);
    }
    await checkpoint();
    // Discovery advances independently of transfers. Each metadata page adds
    // lazy work to the same per-job pool; cursors are persisted before enqueue.
    const scheduled = new Set(), batches = new Set();
    let batchFailure;
    const queueBatch = mediaType => {
      const batch = download(signal, true, mediaType, scheduled);
      batches.add(batch);
      batch.then(() => {}, error => {
        batchFailure ||= error;
        if (!signal.aborted) controller.abort(error);
      }).finally(() => batches.delete(batch));
    };
    const results = await Promise.allSettled(job.directories.filter(directoryEnabled).map(async dir => {
      try {
        if (downloadFiles) queueBatch(dir.mediaType);
        while (dir.state === 'pending') {
          signal.throwIfAborted();
          job.phase = downloadFiles ? 'downloading' : 'scanning';
          current = 'ВК: ' + (dir.mediaType === 'video' ? 'видео' : 'фотографии') + ' · найдено ' + job.files.length + ' файлов';
          trace('page.start', { kind: dir.mediaType, cmid: dir.cursor?.cmid, position: dir.cursor?.position });
          const page = await vk.nextPage(job, signal, text => { current = text; }, dir, getVkPageDelay());
          signal.throwIfAborted();
          consumeVkPage(job, page, dir);
          await onDiscovered(job, page.files);
          trace('page.end', { kind: dir.mediaType, files: page.files.length, cmid: dir.cursor?.cmid, position: dir.cursor?.position, total: job.files.length });
          syncMediaSettings();
          await checkpoint();
          if (downloadFiles && page.files.length) queueBatch(dir.mediaType);
        }
      } catch (error) {
        if (!signal.aborted) controller.abort(error);
        throw error;
      }
    }));
    await Promise.allSettled([...batches]);
    if (batchFailure) throw signal.reason || batchFailure;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw signal.reason || failure.reason;
    signal.throwIfAborted();
    if (downloadFiles) await download(signal);
    else { job.phase = 'ready'; await checkpoint(); }
  }
  function sameSource(record, file) {
    if (job.provider === 'vk') return (record.vkMediaId || record.vkPhotoId) === file.path;
    if (!Number.isFinite(file.size) || record.size !== file.size) return false;
    if (file.sha256) return record.sha256?.toLowerCase() === file.sha256.toLowerCase();
    return !file.modified || record.modified === file.modified;
  }
  async function existing(record, file) {
    if (!record || !sameSource(record, file)) return null;
    if (verifyLocal) return verifyLocal(record);
    const [item] = await waitFor(downloads.search({ id: record.downloadId }), { signal: controller?.signal });
    return item?.state === 'complete' && item.exists === true &&
      item.filename === record.savedPath && item.fileSize === record.savedBytes ? item : null;
  }
  function recordOf(file) {
    return { downloadId: file.downloadId, savedPath: file.savedPath, savedBytes: file.savedBytes,
      savedKind: file.savedKind, size: file.size, sha256: file.sha256, modified: file.modified,
      sourceKey: file.receiptSourceKey || key(file), localFile: !!file.localFile,
      ...(job.provider === 'vk' ? { vkMediaId: file.path } : {}) };
  }
  function reuse(file, record, reason = '') {
    Object.assign(file, { downloadId: record.downloadId, savedPath: record.savedPath, savedBytes: record.savedBytes,
      savedKind: record.savedKind, localFile: !!record.localFile, receiptSourceKey: record.sourceKey || key(file), state: 'done', reused: true, reason });
  }
  async function removeOldPreview(file, history) {
    if (history.original?.localFile || history.preview?.localFile) return;
    if (!history.original || !history.preview || history.original.downloadId === history.preview.downloadId) return;
    // Verify the new original again before considering removal of our own preview.
    if (!await existing(history.original, file)) return;
    const [old] = await waitFor(downloads.search({ id: history.preview.downloadId }), { signal: controller?.signal });
    if (!old || old.exists === false) {
      delete history.preview; await persistHistory(file, history); return;
    }
    if (old.state !== 'complete' || old.filename !== history.preview.savedPath ||
        old.fileSize !== history.preview.savedBytes || !/\.preview\.(jpg|png|webp|gif)$/i.test(old.filename)) return;
    try {
      await waitFor(downloads.removeFile(history.preview.downloadId), { signal: controller?.signal });
      delete history.preview; delete file.cleanupError;
      await persistHistory(file, history);
    } catch (error) { file.cleanupError = 'Оригинал сохранён, но превью осталось: ' + error.message; }
  }
  async function remember(file, signal) {
    await afterSave(job, file, signal);
    const history = await known(file);
    history[file.savedKind] = recordOf(file);
    // Persist original before deleting anything, so interruption never loses the receipt.
    await persistHistory(file, history);
    if (file.savedKind === 'original') await removeOldPreview(file, history);
  }
  async function saveDownload(source, file, kind, signal, direct = false, timeoutMs = getTimeout()) {
    signal.throwIfAborted();
    if (!direct && file.kind === 'photo') {
      fileProgress(file, 'записываем даты фотографии');
      const path = outputPath(job, file, kind, source.type);
      source = await preparePhoto(job, file, source, kind, path, signal);
      signal.throwIfAborted();
    }
    if (saveLocal) {
      file.savedKind = kind; file.savedBytes = direct ? file.size : source.size;
      file.savedPath = outputPath(job, file, kind, direct ? file.mime || '' : source.type);
      file.state = 'active'; file.reused = false; file.localFile = true; file.receiptSourceKey = key(file);
      delete file.downloadId;
      await checkpoint();
      fileProgress(file, 'сохраняем файл');
      Object.assign(file, await saveLocal(file.savedPath, source, { signal, direct, timeout: timeoutMs, expectedSize: file.savedBytes,
        onProgress: bytes => { fileProgress(file, `${(bytes / 1048576).toFixed(1)} МБ`); } }));
      countNewFile();
      return;
    }
    const url = direct ? source : URL.createObjectURL(source);
    let complete = false;
    try {
      file.savedKind = kind; file.savedBytes = direct ? file.size : source.size;
      file.savedPath = outputPath(job, file, kind, direct ? file.mime || '' : source.type);
      file.state = 'active'; file.reused = false; file.receiptSourceKey = key(file);
      delete file.downloadId;
      fileProgress(file, 'ожидаем начала загрузки (до 25 с)');
      await checkpoint();
      file.downloadId = await waitFor(downloads.download({ url, filename: file.savedPath, saveAs: false, conflictAction: 'uniquify' }), {
        signal, timeout: 25000, message: 'Chrome не подтвердил начало загрузки за 25 секунд.',
        onLateValue: id => Number.isInteger(id) ? waitFor(downloads.cancel(id), { timeout: 5000 }) : undefined
      });
      signal.throwIfAborted();
      await checkpoint();
      let lastBytes = 0, lastData = now();
      const deadline = now() + 120000;
      while (true) {
        const [item] = await waitFor(downloads.search({ id: file.downloadId }), { signal });
        if (!item) throw new Error('Chrome потерял запись о загрузке.');
        if (item.state === 'complete') {
          if (item.exists === false) throw new Error('Сохранённый файл не найден.');
          if (Number.isFinite(file.savedBytes) && item.fileSize !== file.savedBytes) {
            if (downloads.discardInvalid) await waitFor(downloads.discardInvalid({ id: file.downloadId, expectedSize: file.savedBytes }), { signal });
            throw new Error('Размер сохранённого файла не совпал.');
          }
          file.savedPath = item.filename; file.savedBytes = item.fileSize;
          countNewFile();
          complete = true; return;
        }
        if (item.state === 'interrupted') throw new Error('Chrome: ' + (item.error || 'загрузка прервана'));
        signal.throwIfAborted();
        if (direct) {
          if (item.bytesReceived > lastBytes) { lastBytes = item.bytesReceived; lastData = now(); }
          const total = Number.isFinite(file.size) ? ` из ${(file.size / 1048576).toFixed(1)}` : '';
          const waiting = Math.floor((now() - lastData) / 1000);
          fileProgress(file, `${(lastBytes / 1048576).toFixed(1)}${total} МБ` +
            (waiting >= 2 ? ` · ждём данные ${waiting}/${timeoutMs / 1000} с` : ''));
          if (now() - lastData >= timeoutMs) throw dataTimeoutError(timeoutMs);
        } else if (now() > deadline) throw new Error('Chrome не завершил сохранение. Проверьте загрузки браузера.');
        await sleep(400);
      }
    } finally {
      if (!complete && Number.isInteger(file.downloadId)) await waitFor(downloads.cancel(file.downloadId), { timeout: 5000 }).catch(() => {});
      if (!direct) URL.revokeObjectURL(url);
    }
  }
  async function downloadOne(file, signal, lease) {
    const wait = async work => {
      if (!lease) return work();
      let released = false;
      try { return await lease.wait(work,
        () => fileProgress(file, 'ждём свободный поток для повтора'),
        () => {
          released = true;
          const transfer = transfers.get(file.path); if (transfer) transfer.slotReleased = true;
          trace('file.slot.release', { file: job.files.indexOf(file), kind: file.kind });
        });
      } finally {
        const transfer = transfers.get(file.path); if (transfer) transfer.slotReleased = false;
        if (released && !signal.aborted) trace('file.slot.acquire', { file: job.files.indexOf(file), kind: file.kind });
      }
    };
    const timeoutMs = getTimeout();
    const retry404 = work => {
      if (job.provider !== 'vk') return work(timeoutMs);
      const policy = notFoundPolicy(file, () => file.vk?.[file.kind === 'video' ? 'video' : kind]?.url,
        () => trace('file.retry.skip', { file: job.files.indexOf(file), kind: file.kind, reason: 'recent-exhausted-404' }));
      return retryNotFound((limit, attempt) => runVkRequest(() => work(limit, attempt), { signal, wait, onStatus: text => fileProgress(file, text) }), { ...policy, signal, timeout: timeoutMs, sleep, wait, onStatus: text => fileProgress(file, text),
      onAttempt: (attempt, ms) => trace('file.attempt.start', { file: job.files.indexOf(file), kind: file.kind, attempt, ms,
        linkAgeMs: file.kind === 'video' && Number.isFinite(file.vk?.video?.receivedAt) ? Math.max(0, now() - file.vk.video.receivedAt) : undefined }),
      onSuccess: (attempt, ms) => { policy.recovered(); trace('file.attempt.end', { file: job.files.indexOf(file), kind: file.kind, attempt, ms }); },
      onError: (error, attempt, ms) => trace('file.attempt.error', { file: job.files.indexOf(file), kind: file.kind, attempt, ms, ...errorInfo(error) }) });
    };
    const local = await findLocal(job, file);
    if (local?.original) {
      reuse(file, local.original, 'Файл уже есть в выбранной папке');
      await remember(file, signal); return;
    }
    const history = await known(file);
    if (await existing(history.original, file)) {
      reuse(file, history.original, 'Уже сохранён полный файл');
      await afterSave(job, file, signal); history.original = recordOf(file);
      await persistHistory(file, history);
      await removeOldPreview(file, history); return;
    }
    const preview = local?.preview || (await existing(history.preview, file) ? history.preview : null);
    // Revisit originals for existing previews on every fresh scan, even after prior failures.
    let kind = !file.retryOriginal && file.kind === 'photo' && (photoQualityForMode(job.mode) === 'preview' || (job.provider !== 'vk' && job.usePreviews && !preview)) ? 'preview' : 'original';
    if (kind === 'preview' && preview) { reuse(file, preview, 'Копия уже сохранена'); await remember(file, signal); return; }
    if (file.kind !== 'photo' && getOriginalUrl) {
      await retry404(async (attemptTimeout, attempt = 0) => {
        fileProgress(file, 'получаем ссылку');
        const url = await getOriginalUrl(job, file, signal, false, text => fileProgress(file, text), wait);
        try { await saveDownload(url, file, 'original', signal, true, attemptTimeout); }
        catch (error) {
          signal.throwIfAborted();
          if (job.provider !== 'vk' || ![401, 403, 404, 410].includes(error.status) || (error.status === 404 && attempt < NOT_FOUND_DELAYS.length)) throw error;
          const refreshed = await vk.getOriginalUrl(job, file, signal, true, text => fileProgress(file, text), wait, { notFound: error.status === 404 });
          if (error.status === 404 && refreshed === url) throw error;
          await saveDownload(refreshed, file, 'original', signal, true, attemptTimeout);
        }
      });
    } else {
      const progress = bytes => { fileProgress(file, `${(bytes / 1048576).toFixed(1)} МБ`); };
      const readPhoto = async () => {
        try {
          return await retry404((attemptTimeout, attempt = 0) => getPhoto(job, file, kind, signal, progress, attemptTimeout,
            text => fileProgress(file, text), { refresh404: attempt === NOT_FOUND_DELAYS.length, wait }));
        } catch (error) {
          signal.throwIfAborted();
          if (job.provider !== 'vk' || kind !== 'preview' || ![403, 404, 410].includes(error.status) || !vk.getPreviewFallback) throw error;
          const fallback = await vk.getPreviewFallback(job, file, signal, progress, timeoutMs,
            text => fileProgress(file, text), { wait, runRequest: runVkRequest });
          if (!fallback) throw error;
          return fallback;
        }
      };
      let blob;
      try {
        fileProgress(file, kind === 'original' ? 'получаем оригинал' : 'получаем копию');
        blob = await readPhoto();
        if (kind === 'original' && file.kind === 'photo') job.originalFailures = 0;
      } catch (error) {
        signal.throwIfAborted();
        if (error.status === 429 || error.vkSession || error.retryable || kind !== 'original' || (photoQualityForMode(job.mode) !== 'auto' && !file.retryOriginal) || file.kind !== 'photo') throw error;
        file.originalError = error.message; job.originalFailures++;
        if (job.originalFailures >= 3 && job.provider !== 'vk') job.usePreviews = true;
        if (preview) { reuse(file, preview, 'Оригинал пока недоступен: ' + error.message); await remember(file, signal); return; }
        kind = 'preview'; fileProgress(file, 'пробуем копию для просмотра');
        blob = await readPhoto();
      }
      await saveDownload(blob, file, kind, signal, false, timeoutMs);
    }
    file.state = 'done';
    file.reason = file.savedKind === 'preview' && file.originalError ? 'Оригинал недоступен: ' + file.originalError : '';
    await remember(file, signal);
  }
  async function download(signal, partial = false, mediaType, scheduled = new Set()) {
    syncMediaSettings();
    job.phase = 'downloading'; await checkpoint();
    const pending = job.files.filter(f => f.state === 'pending' && (!mediaType || f.kind === mediaType) && !scheduled.has(f.path));
    pending.forEach(file => scheduled.add(file.path));
    // All directories have already been scanned. Prioritize photos across the
    // whole selected tree, including when resuming an older saved queue.
    const processFile = async (file, lease) => {
      signal.throwIfAborted();
      fileProgress(file, 'ждём освобождения файла');
      try {
        const lockKey = job.deduplicate && contentKey(file) || key(file);
        const outputKey = 'output:' + outputPath(job, file, 'original', '').normalize('NFC').toLowerCase();
        await withFileLock(outputKey, () => withFileLock(lockKey, async () => {
          signal.throwIfAborted(); fileProgress(file, 'проверяем сохранённый файл'); await downloadOne(file, signal, lease);
        }, signal), signal);
        delete file.retryOriginal;
      }
      catch (error) {
        trace('file.interrupted', { file: job.files.indexOf(file), kind: file.kind, ...errorInfo(error) });
        if (signal.aborted || error.status === 429 || error.localAccess || error.vkSession || error.retryable) {
          if (!signal.aborted) controller.abort(error);
          if (file.state !== 'done') { file.state = 'pending'; delete file.downloadId; }
          await checkpoint(); throw error;
        }
        trace('file.error', { file: job.files.indexOf(file), kind: file.kind, ...errorInfo(error) });
        file.state = 'failed'; file.reason = error.message;
      } finally {
        trace('file.end', { file: job.files.indexOf(file), kind: file.kind, phase: file.state });
        transfers.delete(file.path);
        if (current.startsWith(file.name + ' · ')) {
          const next = [...transfers.values()].at(-1);
          current = next ? next.name + ' · ' + next.status : 'Завершаем обработку файлов…';
        }
      }
      await checkpoint();
    };
    for (const pass of ['photos', 'other']) {
      if (job.provider === 'vk' && !pending.some(f => (f.kind === 'photo') === (pass === 'photos'))) continue;
      job.pass = job.provider === 'vk' ? 'media' : pass;
      await runFiles(pending.filter(f => (f.kind === 'photo') === (pass === 'photos')), processFile, signal);
    }
    if (partial) { await checkpoint(); return; }
    job.phase = 'done'; await checkpoint();
    notice = summary(job).failed || summary(job).directoriesFailed ?
      'Готово с ошибками. Их можно повторить; остальные файлы сохранены.' :
      'Готово. Файлы сохранены в папку альбома.';
  }
  async function recover() {
    if (!job) return;
    migrateDownloadMode(job);
    ensureVkDirectories(job);
    if (job.provider === 'vk') {
      delete job.vkVideoTitles;
      filterVkVideos(job);
      if (job.phase === 'done' && job.files.some(file => file.state === 'pending')) job.phase = 'ready';
    }
    // Upgrade older photo-only queues without losing completed downloads.
    if (job.version < 2) {
      for (const file of job.files) if (file.state === 'skipped' && file.size !== 0) { file.state = 'pending'; file.reason = ''; }
      job.version = 2;
    }
    for (const file of job.files) {
      if (file.state === 'active') {
        const [item] = Number.isInteger(file.downloadId) ? await waitFor(downloads.search({ id: file.downloadId })) : [];
        if (item?.state === 'complete' && item.exists !== false && item.fileSize === file.savedBytes) {
          file.state = 'done'; file.savedPath = item.filename;
        } else {
          if (item?.state === 'in_progress') await waitFor(downloads.cancel(item.id), { timeout: 5000 }).catch(() => {});
          file.state = 'pending'; delete file.downloadId;
        }
      }
      if (file.state === 'done' && Number.isInteger(file.downloadId) && file.savedKind) {
        const history = await loadHistory(key(file)) || {};
        if (!history[file.savedKind]) history[file.savedKind] = recordOf(file);
        await persistHistory(file, history);
      }
    }
    syncMediaSettings();
    await checkpoint();
  }
  const ready = (async () => { job = await loadJob(); await recover(); })();
  async function command(action, args = {}) {
    await ready;
    if (action === 'status') return snapshot(args);
    if (action === 'mode') {
      if (running) throw new Error('Дождитесь остановки текущих загрузок.');
      if (!DOWNLOAD_MODES.includes(args.mode)) throw new Error('Неизвестный режим скачивания.');
      job.mode = args.mode; job.modeVersion = 1; job.usePreviews = false; job.originalFailures = 0;
      syncMediaSettings(); await checkpoint(); return snapshot();
    }
    if (action === 'pause' || action === 'stop') {
      trace('session.control', { action });
      stopping = action === 'stop';
      if (running) controller.abort(new DOMException(stopping ? 'Стоп' : 'Пауза', 'AbortError'));
      else if (stopping && job) { job.phase = 'stopped'; await checkpoint(); notice = 'Остановлено. Сохранённые файлы учтём при новом запуске.'; }
      return snapshot();
    }
    if (running) throw new Error('Это задание уже выполняется.');
    if (action === 'scan') {
      const next = newJob(args.link, args.mode, { deduplicate: args.deduplicate });
      if (job && job.phase !== 'stopped' && (summary(job).pending || job.directories.some(d => d.state === 'pending')) && !args.replace) {
        throw new Error('Есть незавершённая очередь.');
      }
      launch(async signal => {
        job = next; await checkpoint();
        if (job.provider === 'vk') await runVk(signal, args.download !== false);
        else { await scan(signal); if (args.download !== false) await download(signal); }
      });
    } else if (action === 'start' || action === 'retry') {
      if (!job) throw new Error('Сначала укажите ссылку.');
      if (job.phase === 'stopped' && !args.resumeStopped) throw new Error('Задание остановлено. Нажмите «Скачать всё», чтобы проверить папку заново.');
      launch(async signal => {
        if (action === 'retry') {
          // Automatic retries belong to the same manual run, including its new-file count.
          if (!args.preserveNewFiles) job.runNewFiles = 0;
          const previousElapsed = activeTime(job.timeIntervals || []);
          if (job.timingFiles >= 2 && previousElapsed >= 1000) job.previousMsPerFile = previousElapsed / job.timingFiles;
          job.timeIntervals = []; job.timingFiles = 0; timedJob = null; updateClock();
          // Keep this intent on the file so pause/restart still attempts its original.
          if (args.includePreviews === true) {
            for (const f of job.files.filter(f => f.state === 'done' && f.savedKind === 'preview')) {
              f.retryOriginal = true; f.state = 'pending'; f.reason = '';
            }
          }
          for (const f of job.files.filter(f => f.state === 'failed')) { f.state = 'pending'; f.reason = ''; delete f.downloadId; }
          for (const d of job.directories.filter(d => d.state === 'failed')) { d.state = 'pending'; d.reason = ''; }
        }
        if (!job.files.some(f => f.state === 'done') && args.mode) { job.mode = args.mode; job.usePreviews = args.mode === 'preview'; }
        if (job.provider === 'vk') await runVk(signal);
        else {
          if (job.directories.some(d => d.state === 'pending')) await scan(signal);
          await download(signal);
        }
      });
    } else if (action === 'report') {
      if (!job?.folder) throw new Error('Папка ещё не прочитана.');
      if (saveLocal) {
        const blob = new Blob([report(job)], { type: 'text/csv;charset=utf-8' });
        await saveLocal(job.folder + '/download-report-' + now() + '.csv', blob, { expectedSize: blob.size });
        return snapshot();
      }
      const url = URL.createObjectURL(new Blob([report(job)], { type: 'text/csv;charset=utf-8' }));
      try { await downloads.download({ url, filename: job.folder + '/download-report.csv', saveAs: false, conflictAction: 'uniquify' }); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } else throw new Error('Неизвестная команда.');
    return snapshot();
  }
  function heartbeat() {
    if (!job || !running) return;
    const counts = summary(job);
    trace('session.heartbeat', { phase: job.phase, total: counts.total, done: counts.done, failed: counts.failed, pending: counts.pending, active: transfers.size, page: job.pages });
    for (const file of transfers.values()) trace('file.heartbeat', { file: job.files.findIndex(f => f.path === file.path), kind: file.kind, stage: file.status, enabled: !file.slotReleased, unchangedMs: now() - file.changedAt });
  }
  return { command, ready, waitUntilIdle: () => runPromise, heartbeat };
}
