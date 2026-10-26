import { createSourceDates, dateKey, DATE_RESULTS_FILE, readOptionalJson } from './source-dates.js';
import { createPhotoDatesProcessor } from './photo-dates-client.js';

export async function dateIdentity(job, file) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dateKey(job, file.path)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hash(blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function createDateManager({ getDirectory, getRoot, resolveDate, readLocal, process = createPhotoDatesProcessor() }) {
  const source = createSourceDates({ getDirectory, getRoot });
  let records, recordsDir, serial = Promise.resolve();
  const pending = new WeakMap();
  const status = { checked: 0, updated: 0, unchanged: 0, missing: 0, unsupported: 0, errors: 0,
    message: 'Даты новых фотографий записываются в расширении. Даты источников сохраняются в JSON.' };
  const failures = [];
  function problem(error, path = '') {
    status.errors++; status.message = 'Не удалось обработать даты: ' + error.message;
    failures.push({ path, error: error.message }); if (failures.length > 100) failures.shift();
  }
  function recordWork(work) {
    const next = serial.catch(() => {}).then(async () => {
      const dir = await getDirectory();
      if (dir !== recordsDir || !records) {
        const loaded = await readOptionalJson(dir, DATE_RESULTS_FILE);
        if (loaded && (loaded.schema !== 1 || !loaded.files || typeof loaded.files !== 'object' || Array.isArray(loaded.files))) throw new Error('JSON результатов дат повреждён.');
        records = loaded || { schema: 1, files: {} }; recordsDir = dir;
        for (const path of Object.keys(records.files)) {
          if (path.startsWith('vk-messager/')) {
            const next = 'vk-messeger/' + path.slice('vk-messager/'.length);
            records.files[next] ??= records.files[path]; delete records.files[path];
          }
        }
      }
      return work(dir);
    });
    serial = next; return next;
  }
  async function record(path, value) {
    return recordWork(async dir => {
      records.files[path] = value;
      const writer = await (await dir.getFileHandle(DATE_RESULTS_FILE, { create: true })).createWritable();
      try { await writer.write(JSON.stringify(records)); await writer.close(); }
      catch (error) { records = null; await writer.abort().catch(() => {}); throw error; }
    });
  }
  async function mirror(job, files) {
    try { await source.mirror(job, files); } catch (error) { problem(error); }
  }
  return {
    source,
    snapshot: () => ({ ...status, failures: [...failures] }),
    capture: async (job, rows) => { try { if (rows.length) await source.capture(job, rows); } catch (error) { problem(error); } },
    discovered: mirror,
    reset: () => { records = null; recordsDir = null; },
    prepare: async (job, file, blob, kind, path, signal) => {
      if (file.kind !== 'photo') return blob;
      signal?.throwIfAborted(); pending.delete(file);
      try {
        let fallback = await source.get(job, file.path);
        let result = await process(blob, fallback, signal);
        if (result.status === 'needs-date' && !fallback) {
          await resolveDate(job, file, signal);
          fallback = await source.get(job, file.path);
          if (fallback) result = await process(blob, fallback, signal);
        }
        signal?.throwIfAborted(); status.checked++;
        if (result.status === 'updated') {
          const receipt = { state: 'prepared', sourceKey: await dateIdentity(job, file), sourceBytes: kind === 'original' ? file.size : undefined,
            sourceSha256: kind === 'original' ? file.sha256 : undefined, outputBytes: result.blob.size, outputSha256: await hash(result.blob),
            date: result.date, source: result.source, offset: result.offset, fallback: result.fallback };
          // Receipt precedes file commit. After interruption its hash can validate the output.
          await record(path, receipt); pending.set(file, receipt); status.updated++;
        } else if (result.status === 'unchanged') status.unchanged++;
        else if (result.status === 'unsupported') status.unsupported++;
        else status.missing++;
        await mirror(job, [file]);
        return result.blob;
      } catch (error) {
        if (error.status === 429 || error.vkSession || error.retryable) throw error;
        signal?.throwIfAborted(); problem(error, path);
        // Keep the downloaded original when metadata is unavailable; never substitute a damaged output.
        return blob;
      }
    },
    afterSave: async (job, file) => {
      if (file.reused) return; // Existing files are outside this feature's scope.
      await mirror(job, [file]);
      const receipt = pending.get(file); pending.delete(file);
      if (!receipt || !file.localFile) return;
      try {
        const saved = await readLocal(file.savedPath);
        if (saved.size !== receipt.outputBytes) throw new Error('Размер сохранённой фотографии изменился.');
        await record(file.savedPath, { ...receipt, state: 'applied', modifiedMs: saved.lastModified });
      } catch (error) { problem(error, file.savedPath); }
    },
    receipt: async (job, file, local, modifiedMs) => {
      const entry = await recordWork(() => records.files[local.savedPath]);
      if (!entry || !['prepared', 'applied'].includes(entry.state) || entry.sourceKey !== await dateIdentity(job, file) ||
          entry.sourceBytes !== file.size || (file.sha256 && entry.sourceSha256 !== file.sha256) || entry.outputBytes !== local.savedBytes) return false;
      if (Number.isFinite(entry.modifiedMs) && Math.abs(entry.modifiedMs - modifiedMs) <= 1) return true;
      return !!entry.outputSha256 && await hash(await readLocal(local.savedPath)) === entry.outputSha256;
    }
  };
}
