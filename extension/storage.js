let database;
export async function db() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('yandex-photo-downloader', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('jobs')) request.result.createObjectStore('jobs');
      if (!request.result.objectStoreNames.contains('history')) request.result.createObjectStore('history');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  return database;
}

async function read(store, key) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const req = connection.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function write(store, key, value) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить данные.'));
  });
}
export const loadHistory = key => read('history', key);
export const saveHistory = (key, value) => write('history', key, value);
export const saveEntry = entry => write('jobs', 'queue:' + entry.id, entry);
export const loadSettings = async () => await read('jobs', 'settings') || {};
export const saveSettings = settings => write('jobs', 'settings', settings);
export const loadDownloadFolder = () => read('jobs', 'download-folder');
export const saveDownloadFolder = handle => write('jobs', 'download-folder', handle);
// Only portable data: directory handles and temporary picker candidates stay local.
export async function exportState() {
  const entries = await loadEntries(), settings = await loadSettings();
  const connection = await db();
  const history = await new Promise((resolve, reject) => {
    const store = connection.transaction('history').objectStore('history');
    const keys = store.getAllKeys(), values = store.getAll();
    values.onsuccess = () => resolve(keys.result.map((key, i) => [key, values.result[i]]));
    values.onerror = () => reject(values.error);
  });
  return { entries, settings, history };
}
export async function replaceState({ entries, settings, history }) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(['jobs', 'history'], 'readwrite');
    const jobs = tx.objectStore('jobs');
    jobs.delete(IDBKeyRange.bound('queue:', 'queue;')); jobs.delete('current');
    for (const entry of entries) jobs.put(entry, 'queue:' + entry.id);
    jobs.put(settings, 'settings');
    const records = tx.objectStore('history'); records.clear();
    for (const [key, value] of history) records.put(value, key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export const stageDownloadFolder = (token, handle) => write('jobs', 'folder-candidate:' + token, handle);
export const loadFolderCandidate = token => read('jobs', 'folder-candidate:' + token);
export async function clearFolderCandidate(token) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('jobs', 'readwrite');
    tx.objectStore('jobs').delete('folder-candidate:' + token);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function deleteEntry(id) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('jobs', 'readwrite');
    tx.objectStore('jobs').delete('queue:' + id);
    // The legacy record must not reappear when the last queue row is deleted.
    tx.objectStore('jobs').delete('current');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Не удалось обновить задания.'));
  });
}
export async function loadEntries() {
  const connection = await db();
  const entries = await new Promise((resolve, reject) => {
    const tx = connection.transaction('jobs');
    const req = tx.objectStore('jobs').getAll(IDBKeyRange.bound('queue:', 'queue;'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!entries.length) {
    const legacy = await loadJob();
    if (legacy) {
      const entry = { id: 'legacy', job: legacy, wanted: false, action: 'start' };
      await saveEntry(entry); entries.push(entry);
    }
  }
  return entries;
}
export async function loadJob() {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const req = connection.transaction('jobs').objectStore('jobs').get('current');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function saveJob(job) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('jobs', 'readwrite');
    tx.objectStore('jobs').put(job, 'current');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить очередь.'));
  });
}
