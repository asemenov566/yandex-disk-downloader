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
export async function deleteEntry(id) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('jobs', 'readwrite');
    tx.objectStore('jobs').delete('queue:' + id);
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
