import { logFileName } from './logging.js';

// The directory is the same active directory that owns downloader-state.json.
export function createFileLog({ getDirectory }) {
  async function write(directory, name, text, append) {
    const handle = await directory.getFileHandle(name, { create: true });
    let stream;
    try {
      stream = await handle.createWritable({ keepExistingData: append });
      if (append) await stream.seek((await handle.getFile()).size);
      await stream.write(text);
      await stream.close();
    } catch (error) {
      if (stream) await stream.abort().catch(() => {});
      throw error;
    }
  }
  return {
    async append(entries) {
      const directory = await getDirectory();
      // Commit one day at a time. Remove committed rows from the batch so that
      // a failure on the next day's file cannot duplicate the previous day.
      while (entries.length) {
        const name = logFileName(entries[0].at);
        let count = 1;
        while (count < entries.length && logFileName(entries[count].at) === name) count++;
        await write(directory, name, entries.slice(0, count).map(row => JSON.stringify(row)).join('\n') + '\n', true);
        entries.splice(0, count);
      }
    },
    async read(name) {
      const directory = await getDirectory();
      try { return await (await (await directory.getFileHandle(name)).getFile()).text(); }
      catch (error) { if (error.name === 'NotFoundError') return ''; throw error; }
    },
    async clear(name) { await write(await getDirectory(), name, '', false); }
  };
}
