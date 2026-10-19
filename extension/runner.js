import { newJob, summary, report, outputPath, consumePage } from './core.js';
import { waitFor } from './wait.js';

export function createRunner({ loadJob, saveJob, resource, getPhoto, getOriginalUrl, downloads,
  loadHistory = async () => ({}), saveHistory = async () => {}, withFileLock = async (_key, work) => work(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  let job = null, running = false, controller, current = '', notice = '', stopping = false;
  let runPromise = Promise.resolve();
  const checkpoint = () => saveJob(job);
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
    const issues = job ? [...job.directories.filter(d => d.state === 'failed'),
      ...job.files.filter(f => ['failed', 'skipped'].includes(f.state) || f.cleanupError)] : [];
    return { running, current, notice, job: job ? {
      title: job.title, folder: job.folder, phase: job.phase, pass: job.pass, pages: job.pages, mode: job.mode,
      publicUrl: job.publicUrl, path: job.path, deduplicate: !!job.deduplicate, usePreviews: job.usePreviews, summary: summary(job),
      pendingDirectories: job.directories.filter(d => d.state === 'pending').length,
      issuesTotal: issues.length,
      issues: (allIssues ? issues : issues.slice(-30)).map(f => ({ name: f.name || f.path,
        path: [job.rootTitle || job.title || 'Каталог', ...f.path.split('/').filter(Boolean)].join(' / '),
        reason: f.cleanupError || f.reason }))
    } : null };
  }
  function launch(work) {
    running = true; stopping = false; controller = new AbortController(); notice = '';
    runPromise = (async () => {
      try { await work(controller.signal); }
      catch (error) { notice = controller.signal.aborted ? 'Приостановлено. Можно продолжить.' : error.message; }
      finally {
        if (stopping && job) { job.phase = 'stopped'; notice = 'Остановлено. Сохранённые файлы учтём при новом запуске.'; }
        running = false; current = '';
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
      try { consumePage(job, dir, await resource(job, dir.path, dir.offset, signal)); }
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
  function sameSource(record, file) {
    if (!Number.isFinite(file.size) || record.size !== file.size) return false;
    if (file.sha256) return record.sha256?.toLowerCase() === file.sha256.toLowerCase();
    return !file.modified || record.modified === file.modified;
  }
  async function existing(record, file) {
    if (!record || !sameSource(record, file)) return null;
    const [item] = await waitFor(downloads.search({ id: record.downloadId }), { signal: controller?.signal });
    return item?.state === 'complete' && item.exists === true &&
      item.filename === record.savedPath && item.fileSize === record.savedBytes ? item : null;
  }
  function recordOf(file) {
    return { downloadId: file.downloadId, savedPath: file.savedPath, savedBytes: file.savedBytes,
      savedKind: file.savedKind, size: file.size, sha256: file.sha256, modified: file.modified,
      sourceKey: file.receiptSourceKey || key(file) };
  }
  function reuse(file, record, reason = '') {
    Object.assign(file, { downloadId: record.downloadId, savedPath: record.savedPath, savedBytes: record.savedBytes,
      savedKind: record.savedKind, receiptSourceKey: record.sourceKey || key(file), state: 'done', reused: true, reason });
  }
  async function removeOldPreview(file, history) {
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
  async function remember(file) {
    const history = await known(file);
    history[file.savedKind] = recordOf(file);
    // Persist original before deleting anything, so interruption never loses the receipt.
    await persistHistory(file, history);
    if (file.savedKind === 'original') await removeOldPreview(file, history);
  }
  async function saveDownload(source, file, kind, signal, direct = false) {
    signal.throwIfAborted();
    const url = direct ? source : URL.createObjectURL(source);
    let complete = false;
    try {
      file.savedKind = kind; file.savedBytes = direct ? file.size : source.size;
      file.savedPath = outputPath(job, file, kind, direct ? file.mime || '' : source.type);
      file.state = 'active'; file.reused = false; file.receiptSourceKey = key(file);
      delete file.downloadId;
      current = file.name + ' · ожидаем начала загрузки (до 25 с)';
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
          complete = true; return;
        }
        if (item.state === 'interrupted') throw new Error('Chrome: ' + (item.error || 'загрузка прервана'));
        signal.throwIfAborted();
        if (direct) {
          if (item.bytesReceived > lastBytes) { lastBytes = item.bytesReceived; lastData = now(); }
          const total = Number.isFinite(file.size) ? ` из ${(file.size / 1048576).toFixed(1)}` : '';
          const waiting = Math.floor((now() - lastData) / 1000);
          current = `${file.name} · ${(lastBytes / 1048576).toFixed(1)}${total} МБ` +
            (waiting >= 2 ? ` · ждём данные ${waiting}/25 с` : '');
          if (now() - lastData >= 25000) throw new Error('Нет данных от файлового сервера 25 секунд.');
        } else if (now() > deadline) throw new Error('Chrome не завершил сохранение. Проверьте загрузки браузера.');
        await sleep(400);
      }
    } finally {
      if (!complete && Number.isInteger(file.downloadId)) await waitFor(downloads.cancel(file.downloadId), { timeout: 5000 }).catch(() => {});
      if (!direct) URL.revokeObjectURL(url);
    }
  }
  async function downloadOne(file, signal) {
    const history = await known(file);
    if (await existing(history.original, file)) {
      reuse(file, history.original, 'Уже сохранён полный файл');
      await persistHistory(file, history);
      await removeOldPreview(file, history); return;
    }
    const preview = await existing(history.preview, file) ? history.preview : null;
    // Revisit originals for existing previews on every fresh scan, even after prior failures.
    let kind = !file.retryOriginal && file.kind === 'photo' && (job.mode === 'preview' || (job.usePreviews && !preview)) ? 'preview' : 'original';
    if (kind === 'preview' && preview) { reuse(file, preview, 'Копия уже сохранена'); return; }
    if (file.kind !== 'photo' && getOriginalUrl) {
      current = file.name + ' · получаем ссылку (до 20 с)';
      const url = await getOriginalUrl(job, file, signal);
      await saveDownload(url, file, 'original', signal, true);
    } else {
      const progress = bytes => { current = `${file.name} · ${(bytes / 1048576).toFixed(1)} МБ`; };
      let blob;
      try {
        blob = await getPhoto(job, file, kind, signal, progress);
        if (kind === 'original' && file.kind === 'photo') job.originalFailures = 0;
      } catch (error) {
        signal.throwIfAborted();
        if (error.status === 429 || kind !== 'original' || (job.mode !== 'auto' && !file.retryOriginal) || file.kind !== 'photo') throw error;
        file.originalError = error.message; job.originalFailures++;
        if (job.originalFailures >= 3) job.usePreviews = true;
        if (preview) { reuse(file, preview, 'Оригинал пока недоступен: ' + error.message); return; }
        kind = 'preview'; current = file.name + ' · пробуем копию для просмотра';
        blob = await getPhoto(job, file, kind, signal, progress);
      }
      await saveDownload(blob, file, kind, signal);
    }
    file.state = 'done';
    file.reason = file.savedKind === 'preview' && file.originalError ? 'Оригинал недоступен: ' + file.originalError : '';
    await remember(file);
  }
  async function download(signal) {
    job.phase = 'downloading'; await checkpoint();
    const pending = job.files.filter(f => f.state === 'pending');
    // All directories have already been scanned. Prioritize photos across the
    // whole selected tree, including when resuming an older saved queue.
    const ordered = [...pending.filter(f => f.kind === 'photo'), ...pending.filter(f => f.kind !== 'photo')];
    for (const file of ordered) {
      job.pass = file.kind === 'photo' ? 'photos' : 'other';
      signal.throwIfAborted(); current = file.name;
      try {
        const lockKey = job.deduplicate && contentKey(file) || key(file);
        await withFileLock(lockKey, async () => { signal.throwIfAborted(); await downloadOne(file, signal); }, signal);
        delete file.retryOriginal;
      }
      catch (error) {
        if (signal.aborted || error.status === 429) {
          if (file.state !== 'done') { file.state = 'pending'; delete file.downloadId; }
          await checkpoint(); throw error;
        }
        file.state = 'failed'; file.reason = error.message;
      }
      await checkpoint(); await sleep(250);
    }
    job.phase = 'done'; await checkpoint();
    notice = summary(job).failed || summary(job).directoriesFailed ?
      'Готово с ошибками. Их можно повторить; остальные файлы сохранены.' :
      'Готово. Файлы сохранены в папку альбома внутри «Загрузки / yandex-disk».';
  }
  async function recover() {
    if (!job) return;
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
    await checkpoint();
  }
  const ready = (async () => { job = await loadJob(); await recover(); })();
  async function command(action, args = {}) {
    await ready;
    if (action === 'status') return snapshot(args);
    if (action === 'pause' || action === 'stop') {
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
      launch(async signal => { job = next; await checkpoint(); await scan(signal); if (args.download !== false) await download(signal); });
    } else if (action === 'start' || action === 'retry') {
      if (!job) throw new Error('Сначала укажите ссылку.');
      if (job.phase === 'stopped') throw new Error('Задание остановлено. Нажмите «Скачать всё», чтобы проверить папку заново.');
      launch(async signal => {
        if (action === 'retry') {
          // Keep this intent on the file so pause/restart still attempts its original.
          if (args.includePreviews === true) {
            for (const f of job.files.filter(f => f.state === 'done' && f.savedKind === 'preview')) {
              f.retryOriginal = true; f.state = 'pending'; f.reason = '';
            }
          }
          for (const f of job.files.filter(f => f.state === 'failed')) { f.state = 'pending'; f.reason = ''; delete f.downloadId; }
          for (const d of job.directories.filter(d => d.state === 'failed')) { d.state = 'pending'; d.reason = ''; }
        }
        if (job.directories.some(d => d.state === 'pending')) await scan(signal);
        if (!job.files.some(f => f.state === 'done') && args.mode) { job.mode = args.mode; job.usePreviews = args.mode === 'preview'; }
        await download(signal);
      });
    } else if (action === 'report') {
      if (!job?.folder) throw new Error('Папка ещё не прочитана.');
      const url = URL.createObjectURL(new Blob([report(job)], { type: 'text/csv;charset=utf-8' }));
      try { await downloads.download({ url, filename: job.folder + '/download-report.csv', saveAs: false, conflictAction: 'uniquify' }); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } else throw new Error('Неизвестная команда.');
    return snapshot();
  }
  return { command, ready, waitUntilIdle: () => runPromise };
}
