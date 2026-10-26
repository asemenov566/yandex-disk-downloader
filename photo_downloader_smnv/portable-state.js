import { parseLink } from './core.js';
import { requireFolder } from './local-files.js';
import { STORED_MODES } from './modes.js';

export const STATE_FILE = 'downloader-state.json';
export const BACKUP_FILES = ['downloader-state.backup-1.json', 'downloader-state.backup-2.json'];
export const SCHEMA_VERSION = 1;
const FORMAT = 'yandex-disk-downloader';
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Object.assign(new Error('Файл базы повреждён или имеет неизвестный формат. Исходный JSON не изменён.'), { stateCorrupt: true });
const relative = value => typeof value === 'string' && !value.split('/').some(p => p === '.' || p === '..') && !/[\\:\u0000]/.test(value);

// This registry is extended when the JSON schema changes. Each step must produce
// the next schema; never guess how to downgrade a file written by a newer app.
const migrations = new Map();
export function decodeState(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw invalid(); }
  if (!object(data) || data.format !== FORMAT || !Number.isInteger(data.schemaVersion)) throw invalid();
  if (data.schemaVersion > SCHEMA_VERSION) throw new Error('Эта база создана более новой версией расширения. Обновите расширение; файл не изменён.');
  let migrated = false;
  while (data.schemaVersion < SCHEMA_VERSION) {
    const migrate = migrations.get(data.schemaVersion);
    if (!migrate) throw invalid();
    const previous = data.schemaVersion;
    data = migrate(data);
    if (data.schemaVersion !== previous + 1) throw invalid();
    migrated = true;
  }
  if (!Array.isArray(data.entries) || !Array.isArray(data.history) || !object(data.settings)) throw invalid();
  const renameSavedPath = value => typeof value === 'string' && value.startsWith('vk-messager/') ? 'vk-messeger/' + value.slice('vk-messager/'.length) : value;
  const migratePath = (item, key) => { const next = renameSavedPath(item[key]); if (next !== item[key]) { item[key] = next; migrated = true; } };
  const ids = new Set();
  for (const entry of data.entries) {
    const job = entry?.job;
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || !object(job)) throw invalid();
    ids.add(entry.id); migratePath(job, 'folder');
    if (![1, 2].includes(job.version)) throw new Error('Неизвестная версия задания в базе. Обновите расширение; файл не изменён.');
    if (job.timeIntervals != null && (!Array.isArray(job.timeIntervals) || job.timeIntervals.some(range =>
      !Array.isArray(range) || range.length !== 2 || !range.every(value => Number.isFinite(value) && value >= 0) || range[1] < range[0]))) throw invalid();
    let source;
    try { source = parseLink(job.publicUrl); } catch { throw invalid(); }
    if (source.provider !== job.provider || (source.provider === 'vk' && (source.peerId !== job.peerId || job.path !== '/'))) throw invalid();
    if (typeof job.created !== 'string' || !relative(job.path) || !job.path.startsWith('/') ||
        !relative(job.folder) || (job.folder && !job.folder.startsWith(source.provider === 'vk' ? 'vk-messeger/' : 'yandex-disk/')) ||
        !STORED_MODES.includes(job.mode) || (job.modeVersion != null && job.modeVersion !== 1) ||
        !['scanning', 'ready', 'downloading', 'done', 'stopped'].includes(job.phase) ||
        !Array.isArray(job.files) || !Array.isArray(job.directories) || !object(job.usedPaths)) throw invalid();
    for (const file of job.files) {
      if (!object(file) || !relative(file.local) || !relative(file.path) || typeof file.name !== 'string' ||
          !['photo', 'video', 'other'].includes(file.kind) || !['pending', 'active', 'done', 'failed', 'skipped'].includes(file.state)) throw invalid();
      migratePath(file, 'savedPath');
      // Browser download ids are profile-specific and must never be replayed.
      delete file.downloadId;
      if (file.state === 'active') file.state = 'pending';
      if (job.version === 1 && file.state === 'skipped' && file.size !== 0) { file.state = 'pending'; file.reason = ''; }
    }
    for (const dir of job.directories) {
      if (!object(dir) || !relative(dir.path) || !relative(dir.local) || !Number.isInteger(dir.offset) || dir.offset < 0 ||
          !['pending', 'done', 'failed'].includes(dir.state)) throw invalid();
    }
    if (job.version === 1) { job.version = 2; migrated = true; }
    if (entry.wanted && entry.action === 'retry') entry.suspendedRetry = { ...entry.actionArgs };
    entry.wanted = false;
  }
  for (const row of data.history) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !object(row[1])) throw invalid();
    for (const record of Object.values(row[1])) {
      if (!object(record)) throw invalid();
      migratePath(record, 'savedPath');
      delete record.downloadId;
    }
  }
  return { data, migrated };
}

export function encodeState(state, extensionVersion) {
  return JSON.stringify({ format: FORMAT, schemaVersion: SCHEMA_VERSION, extensionVersion,
    updatedAt: new Date().toISOString(), ...state }, (key, value) => key === 'downloadId' ? undefined : value);
}

async function writeJson(directory, name, text) {
  let stream;
  try {
    const handle = await directory.getFileHandle(name, { create: true });
    stream = await handle.createWritable();
    await stream.write(text);
    await stream.close();
    if (await (await handle.getFile()).text() !== text) throw new Error('Проверка записанного файла не прошла.');
  } catch (error) {
    if (stream) await stream.abort().catch(() => {});
    throw Object.assign(new Error('Не удалось сохранить базу в папке: ' + error.message), { localAccess: true });
  }
}

export function createPortableStorage({ cache, extensionVersion, now = Date.now }) {
  let state, entries, history, root = null, directory = null, blocked = null;
  let dirty = 0, saved = 0, writing = null, backupAt = 0, backupIndex = 0, warning = '', cacheProblem = null;
  const setState = value => {
    state = { settings: clone(value.settings) };
    entries = new Map(value.entries.map(entry => [entry.id, clone(entry)]));
    history = new Map(value.history.map(([key, record]) => [key, clone(record)]));
  };
  const snapshot = () => ({ entries: [...entries.values()], settings: state.settings, history: [...history] });
  async function flush() {
    if (!directory) return;
    if (!writing) {
      writing = Promise.resolve().then(async () => {
        while (saved !== dirty) {
          const revision = dirty;
          await requireFolder(root);
          const text = encodeState(snapshot(), extensionVersion);
          // Alternate backups at most once a minute, before replacing the main
          // file. Keep an older generation if a crash interrupts a new write.
          if (now() - backupAt >= 60000) {
            await writeJson(directory, BACKUP_FILES[backupIndex], text);
            backupIndex = (backupIndex + 1) % BACKUP_FILES.length; backupAt = now();
          }
          await writeJson(directory, STATE_FILE, text);
          saved = revision;
        }
      }).finally(() => { writing = null; });
    }
    return writing;
  }
  async function activate(handle) {
    await requireFolder(handle);
    const dir = await handle.getDirectoryHandle('photo_downloader_smnv', { create: true });
    let text = null;
    try { text = await (await (await dir.getFileHandle(STATE_FILE)).getFile()).text(); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    if (text === null) {
      try {
        const old = await handle.getDirectoryHandle('yandex-disk');
        await old.getFileHandle(STATE_FILE);
        throw Object.assign(new Error('Найдена база в старой папке yandex-disk. Перенесите базы и папки в photo_downloader_smnv перед запуском. Старые данные не изменены.'), { localAccess: true });
      } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
    if (text === null && cacheProblem) throw cacheProblem;
    let decoded, recoveredFrom = '';
    try { decoded = text === null ? decodeState(encodeState(snapshot(), extensionVersion)) : decodeState(text); }
    catch (error) {
      if (!error.stateCorrupt || text === null) throw error;
      const candidates = [];
      for (const name of BACKUP_FILES) {
        try {
          const backupText = await (await (await dir.getFileHandle(name)).getFile()).text();
          const result = decodeState(backupText);
          candidates.push({ name, result, text: backupText, at: Date.parse(result.data.updatedAt) || 0 });
        } catch { /* An invalid backup must never replace the main file. */ }
      }
      candidates.sort((a, b) => b.at - a.at);
      if (!candidates.length) throw error;
      await writeJson(dir, 'downloader-state.corrupt-' + now() + '-' + crypto.randomUUID() + '.json', text);
      const backup = candidates[0]; decoded = backup.result; text = backup.text; recoveredFrom = backup.name;
    }
    // Preserve the byte-for-byte original before a schema/job migration.
    if (decoded.migrated) {
      await writeJson(dir, `downloader-state.before-migration-${Date.now()}-${crypto.randomUUID()}.json`, text ?? encodeState(snapshot(), extensionVersion));
    }
    const next = { entries: decoded.data.entries, settings: decoded.data.settings, history: decoded.data.history };
    const nextText = encodeState(next, extensionVersion);
    await writeJson(dir, BACKUP_FILES[0], text ?? nextText);
    await writeJson(dir, STATE_FILE, nextText);
    await cache.replaceState(next);
    setState(next); root = handle; directory = dir; dirty = saved = 0; blocked = null; cacheProblem = null;
    backupAt = now(); backupIndex = 1;
    warning = recoveredFrom ? 'База восстановлена из ' + recoveredFrom + '. Повреждённый файл сохранён отдельно; проверьте последние задания.' : '';
    return clone(next);
  }
  const ready = (async () => {
    // A damaged browser cache must not prevent opening a valid disk database.
    // Do not write the empty fallback anywhere until a disk state is selected.
    let cacheError = null;
    try {
      const cached = await cache.exportState();
      const normalized = decodeState(encodeState(cached, extensionVersion));
      setState(normalized.data);
    } catch {
      cacheError = cacheProblem = new Error('Локальная копия базы браузера повреждена. Подключите папку с исправной JSON-базой в настройках.');
      setState({ entries: [], history: [], settings: {} });
    }
    let handle;
    try { handle = await cache.loadDownloadFolder(); }
    catch { blocked = cacheError || new Error('Не удалось прочитать сохранённую папку. Выберите её заново в настройках.'); return; }
    if (handle) {
      try { await activate(handle); } catch (error) { blocked = error; }
    } else if (cacheError) blocked = cacheError;
  })();
  return {
    ready,
    get error() { return blocked; },
    get warning() { return warning; },
    logDirectory: async () => {
      await ready;
      if (blocked) throw blocked;
      await requireFolder(root);
      if (!directory) throw new Error('Подтвердите папку с JSON-базой для записи журнала.');
      return directory;
    },
    loadEntries: async () => { await ready; return clone([...entries.values()]); },
    loadSettings: async () => { await ready; return clone(state.settings); },
    loadHistory: async key => { await ready; return clone(history.get(key)); },
    saveEntry: async entry => {
      await ready; entries.set(entry.id, clone(entry));
      await cache.saveEntry(entry); dirty++; await flush();
    },
    // Receipts are committed alongside the runner's next checkpoint, avoiding
    // several full JSON rewrites for the same file. No transfer resumes before it.
    saveHistory: async (key, record) => {
      await ready; history.set(key, clone(record)); await cache.saveHistory(key, record); dirty++;
    },
    saveSettings: async settings => {
      await ready; if (blocked) throw blocked;
      state.settings = clone(settings); await cache.saveSettings(settings); dirty++; await flush();
    },
    deleteEntry: async id => {
      await ready; if (blocked) throw blocked;
      entries.delete(id); await cache.deleteEntry(id); dirty++; await flush();
    },
    prepare: async handle => {
      await ready; if (blocked) throw blocked;
      await requireFolder(handle);
      if (!directory) throw new Error('Подтвердите сохранённую папку в настройках, чтобы подключить JSON-базу.');
      await flush();
    },
    changeFolder: async handle => {
      await ready;
      // Old-folder checkpoints were awaited by stopAll before opening the picker.
      if (writing) await writing;
      return activate(handle);
    }
  };
}
