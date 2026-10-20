import test from 'node:test';
import assert from 'node:assert/strict';
import { getPhoto, resource } from '../extension/network.js';

const job = { publicUrl: 'https://disk.yandex.ru/d/test' };
const file = { path: '/a.JPG', size: 3, mime: 'image/jpeg' };
function harness(fetchFn, decoder = async () => ({ close() {} })) {
  const previousFetch = globalThis.fetch, previousDecoder = globalThis.createImageBitmap;
  globalThis.fetch = fetchFn; globalThis.createImageBitmap = decoder;
  return () => { globalThis.fetch = previousFetch; globalThis.createImageBitmap = previousDecoder; };
}
test('metadata request carries pagination, full public key and preview settings', async () => {
  const restore = harness(async url => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('offset'), '400');
    assert.equal(u.searchParams.get('limit'), '200');
    assert.equal(u.searchParams.get('public_key'), job.publicUrl);
    assert.equal(u.searchParams.get('preview_size'), 'XXXL');
    return Response.json({ ok: true });
  });
  try { await resource(job, '/folder', 400, new AbortController().signal); } finally { restore(); }
});

test('valid preview is decoded before it can be saved', async () => {
  let decoded = false;
  const restore = harness(async url => String(url).startsWith('https://cloud-api')
    ? Response.json({ preview: 'https://downloader.disk.yandex.ru/preview/a' })
    : new Response(new Uint8Array([1,2,3]), { headers: { 'Content-Type': 'image/jpeg' } }),
  async blob => { assert.equal(blob.size, 3); decoded = true; return { close() {} }; });
  try {
    const blob = await getPhoto(job, file, 'preview', new AbortController().signal);
    assert.equal(blob.size, 3); assert(decoded);
  } finally { restore(); }
});

test('HTML error and corrupt image are rejected, never saved as successful photos', async () => {
  for (const type of ['text/html','image/jpeg']) {
    const restore = harness(async url => String(url).startsWith('https://cloud-api')
      ? Response.json({ preview: 'https://downloader.disk.yandex.ru/preview/a' })
      : new Response('bad image', { headers: { 'Content-Type': type } }), async () => { throw new Error('Bad image'); });
    try { await assert.rejects(getPhoto(job, file, 'preview', new AbortController().signal)); } finally { restore(); }
  }
});

test('truncated originals and incorrect checksum are rejected', async () => {
  for (const metadata of [{ ...file, size: 9 }, { ...file, sha256: '0'.repeat(64) }]) {
    const restore = harness(async url => String(url).startsWith('https://cloud-api')
      ? Response.json({ href: 'https://downloader.disk.yandex.ru/disk/a' })
      : new Response(new Uint8Array([1,2,3]), { headers: { 'Content-Type': 'image/jpeg' } }));
    try { await assert.rejects(getPhoto(job, metadata, 'original', new AbortController().signal), /Размер|сумма/); } finally { restore(); }
  }
});

test('rate limiting is distinguishable from individual broken files', async () => {
  const restore = harness(async () => new Response('', { status: 429 }));
  try { await assert.rejects(resource(job, '/', 0, new AbortController().signal), error => error.status === 429); } finally { restore(); }
});

test('user pause aborts fetch and does not leave a running timeout', async () => {
  const controller = new AbortController(); controller.abort();
  const restore = harness(async (url, options) => { options.signal.throwIfAborted(); });
  try { await assert.rejects(getPhoto(job, file, 'preview', controller.signal), error => error.name === 'AbortError'); } finally { restore(); }
});

test('photo transfer obeys the selected no-data timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const seconds of [5, 25, 240]) {
    let entered, signal;
    const started = new Promise(resolve => { entered = resolve; });
    const restore = harness(async (url, options) => {
      if (String(url).startsWith('https://cloud-api')) return Response.json({ href: 'https://downloader.disk.yandex.ru/a' });
      signal = options.signal; entered();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    try {
      const transfer = getPhoto(job, file, 'original', new AbortController().signal, () => {}, seconds * 1000);
      await started;
      t.mock.timers.tick(seconds * 1000 - 1); assert.equal(signal.aborted, false);
      t.mock.timers.tick(1);
      await assert.rejects(transfer, new RegExp(seconds + ' с'));
    } finally { restore(); }
  }
});
