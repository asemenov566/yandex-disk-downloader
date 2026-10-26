import { processPhoto } from './photo-dates.js';
self.onmessage = async ({ data }) => {
  try { self.postMessage({ ok: true, value: await processPhoto(data.blob, data.fallback) }); }
  catch (error) { self.postMessage({ ok: false, error: error.message }); }
};
