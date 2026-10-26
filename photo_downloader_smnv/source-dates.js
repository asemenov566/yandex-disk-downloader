// Source dates live outside downloader-state.json. No media URLs or credentials.
export const DATES_FILE = 'downloader-dates.json';
export const DATE_RESULTS_FILE = 'downloader-date-results.json';
export const dateKey = (job, path) => JSON.stringify([job.publicUrl, path]);
export function validDate(value, seconds = false) {
  if (value === null || value === undefined || value === '') return null;
  const time = seconds ? (typeof value === 'number' && value > 0 ? value * 1000 : NaN) : Date.parse(value);
  return Number.isFinite(time) && time > 0 && time <= Date.now() + 86400000 ? new Date(time).toISOString() : null;
}
export function vkSourceDates(items) {
  return (items || []).flatMap(item => {
    const kind = item?.attachment?.type, media = item?.attachment?.[kind];
    if (!['photo', 'video'].includes(kind) || !Number.isSafeInteger(media?.id) || !Number.isSafeInteger(media?.owner_id)) return [];
    const uploaded = validDate(media.date, true), sent = validDate(item.date, true);
    return uploaded || sent ? [[`/${kind}${media.owner_id}_${media.id}`, { date: uploaded || sent, source: uploaded ? `vk.${kind}.date` : 'vk.item.date' }]] : [];
  });
}
export function ydSourceDates(resource) {
  return [resource, ...(resource?._embedded?.items || [])].flatMap(item => {
    const date = validDate(item?.created);
    return item?.type === 'file' && item.path && date ? [[item.path, { date, source: 'yandex.created' }]] : [];
  });
}
export async function readOptionalJson(directory, name) {
  try { return JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text()); }
  catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
}
export function createSourceDates({ getDirectory, getRoot, uuid = () => crypto.randomUUID() }) {
  let directory, data, serial = Promise.resolve();
  async function load() {
    const next = await getDirectory();
    if (directory === next && data) return;
    const loaded = await readOptionalJson(next, DATES_FILE);
    if (loaded && (loaded.schema !== 1 || typeof loaded.rootId !== 'string' || !loaded.dates || typeof loaded.dates !== 'object' || Array.isArray(loaded.dates))) {
      throw new Error('Отдельный JSON с датами повреждён. Основная база не изменена.');
    }
    directory = next; data = loaded || { schema: 1, rootId: uuid(), dates: {} };
  }
  async function write() {
    const handle = await directory.getFileHandle(DATES_FILE, { create: true });
    const writer = await handle.createWritable();
    try { await writer.write(JSON.stringify(data)); await writer.close(); }
    catch (error) { await writer.abort().catch(() => {}); data = null; throw error; }
  }
  function run(work) {
    const result = serial.catch(() => {}).then(async () => { await load(); return work(); });
    serial = result; return result;
  }
  async function mirror(job, files) {
    if (!getRoot || !job.folder || !files.length) return;
    const groups = new Map();
    for (const file of files) {
      const value = data.dates[dateKey(job, file.path)];
      if (!value || !file.local) continue;
      const path = job.folder + '/' + file.local, parent = path.slice(0, path.lastIndexOf('/'));
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push([file, value]);
    }
    for (const [parent, rows] of groups) {
      const parts = parent.split('/');
      if (!['yandex-disk', 'vk-messeger'].includes(parts[0]) || parts.some(p => !p || p === '.' || p === '..' || /[\\:]/.test(p))) throw new Error('Некорректная папка дат.');
      let dir = await getRoot();
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const local = await readOptionalJson(dir, DATES_FILE) || { schema: 1, rootId: data.rootId, folder: parent, dates: {} };
      if (local.schema !== 1 || !local.dates || typeof local.dates !== 'object' || Array.isArray(local.dates)) throw new Error('JSON дат папки повреждён: ' + parent);
      local.folder = parent;
      for (const [file, value] of rows) {
        const key = dateKey(job, file.path), old = local.dates[key];
        const saved = [...new Set([...(old?.saved || []), ...(file.savedPath?.startsWith(parent + '/') ? [file.savedPath.slice(parent.length + 1)] : [])])];
        local.dates[key] = { ...value, local: file.local.split('/').at(-1), ...(saved.length ? { saved } : {}) };
      }
      const writer = await (await dir.getFileHandle(DATES_FILE, { create: true })).createWritable();
      try { await writer.write(JSON.stringify(local)); await writer.close(); }
      catch (error) { await writer.abort().catch(() => {}); throw error; }
    }
  }
  return {
    rootId: () => run(async () => { await write(); return data.rootId; }),
    get: (job, path) => run(() => data.dates[dateKey(job, path)] || null),
    mirror: (job, files) => run(() => mirror(job, files)),
    capture: (job, rows) => run(async () => {
      let changed = false;
      for (const [path, value] of rows) {
        const key = dateKey(job, path), old = data.dates[key];
        // A message date must not downgrade a known upload date.
        if (old && old.source !== 'vk.item.date' && value.source === 'vk.item.date') continue;
        if (old?.date !== value.date || old?.source !== value.source) { data.dates[key] = value; changed = true; }
      }
      if (changed) await write();
      const paths = new Set(rows.map(([path]) => path));
      await mirror(job, (job.files || []).filter(file => paths.has(file.path)));
    })
  };
}
