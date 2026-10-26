// Opt-in live check: node tests/live-preview.mjs PUBLIC_URL OUTPUT_DIRECTORY
// Downloads only previews. Run a real image decoder on the resulting files too.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newJob, consumePage, outputPath, summary, report } from '../photo_downloader_smnv/core.js';
import { resource, getPhoto } from '../photo_downloader_smnv/network.js';
const [link, destination] = process.argv.slice(2);
if (!link || !destination) throw new Error('Expected a public link and output directory.');
globalThis.createImageBitmap = async blob => {
  const data = new Uint8Array(await blob.arrayBuffer());
  if (!(data[0] === 0xff && data[1] === 0xd8)) throw new Error('Expected a JPEG image.');
  return { close() {} };
};
const job = newJob(link, 'preview');
const signal = new AbortController().signal;
if (job.path !== '/') job.rootTitle = (await resource(job, '/', 0, signal)).name;
while (job.directories.some(dir => dir.state === 'pending')) {
  const dir = job.directories.find(dir => dir.state === 'pending');
  const page = await resource(job, dir.path, dir.offset, signal);
  consumePage(job, dir, page);
}
console.log(JSON.stringify({ stage: 'scanned', ...summary(job) }));
for (const file of job.files.filter(file => file.state === 'pending' && file.kind === 'photo')) {
  try {
    const blob = await getPhoto(job, file, 'preview', signal);
    const output = path.resolve(destination, outputPath(job, file, 'preview', blob.type));
    const root = path.resolve(destination) + path.sep;
    if (!output.startsWith(root)) throw new Error('Unsafe path');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(await blob.arrayBuffer()), { flag: 'wx' });
    file.state = 'done'; file.savedKind = 'preview'; file.savedPath = output;
    console.log('Saved: ' + file.name + ' (' + blob.size + ' bytes)');
  } catch (error) {
    file.state = 'failed'; file.reason = error.message;
    console.log('Skipped: ' + file.name + ' — ' + error.message);
  }
}
await mkdir(destination, { recursive: true });
await writeFile(path.join(destination, 'test-report.csv'), report(job));
console.log(JSON.stringify({ stage: 'complete', ...summary(job) }));
