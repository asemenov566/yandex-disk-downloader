// Runs in a dedicated worker. ExifTool and its WASM are bundled, never fetched
// from a CDN. Pixels and compression are not changed by metadata writes.
import { parseMetadata, writeMetadata } from './vendor/exiftool/index.js';

export function parsePhotoDate(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^([12]\d{3})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, fraction = '', zone = ''] = m;
  const check = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) return null;
  if (zone && zone !== 'Z' && (+zone.slice(1, 3) > 14 || +zone.slice(4) > 59)) return null;
  return { text: `${y}:${mo}:${d} ${h}:${mi}:${s}`, fraction: fraction.slice(1), zone: zone === 'Z' ? '+00:00' : zone };
}

function sourceDate(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  const d = new Date(iso), pad = n => String(n).padStart(2, '0'), offset = -d.getTimezoneOffset();
  return { text: `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    zone: `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`, fraction: '' };
}

export function photoDatePlan(meta, fallback) {
  const candidates = ['ExifIFD:DateTimeOriginal', 'XMP-exif:DateTimeOriginal', 'XMP-photoshop:DateCreated',
    'ExifIFD:CreateDate', 'XMP-xmp:CreateDate'];
  let chosen, origin;
  for (const tag of candidates) {
    chosen = parsePhotoDate(meta[tag]);
    if (chosen) {
      origin = tag;
      if (tag.startsWith('ExifIFD:')) {
        const original = tag.endsWith('DateTimeOriginal');
        const zone = meta['ExifIFD:OffsetTime' + (original ? 'Original' : 'Digitized')];
        if (/^[+-]\d{2}:\d{2}$/.test(zone || '')) chosen.zone = zone;
        const sub = meta['ExifIFD:SubSecTime' + (original ? 'Original' : 'Digitized')];
        if (/^\d+$/.test(String(sub || ''))) chosen.fraction = String(sub);
      }
      break;
    }
  }
  if (!chosen && meta['IPTC:DateCreated'] && meta['IPTC:TimeCreated']) {
    chosen = parsePhotoDate(meta['IPTC:DateCreated'] + ' ' + meta['IPTC:TimeCreated']);
    if (chosen) origin = 'IPTC:DateCreated';
  }
  chosen ||= sourceDate(fallback?.date);
  if (!chosen) return { status: 'needs-date' };
  const format = meta['File:FileType'];
  // These containers cannot carry EXIF. Do not change their format to fake support.
  if (['BMP', 'ICO'].includes(format)) return { status: 'unsupported', format };
  const tags = {};
  const xmpOnly = format === 'GIF';
  for (const [read, write, suffix] of xmpOnly
    ? [['XMP-exif:DateTimeOriginal', 'XMP-exif:DateTimeOriginal', 'Original'], ['XMP-xmp:CreateDate', 'XMP-xmp:CreateDate', 'Digitized']]
    : [['ExifIFD:DateTimeOriginal', 'EXIF:DateTimeOriginal', 'Original'], ['ExifIFD:CreateDate', 'EXIF:CreateDate', 'Digitized']]) {
    if (parsePhotoDate(meta[read])) continue;
    tags[write] = chosen.text + (xmpOnly ? (chosen.fraction ? '.' + chosen.fraction : '') + chosen.zone : '');
    if (!xmpOnly) {
      if (chosen.zone) tags['EXIF:OffsetTime' + suffix] = chosen.zone;
      if (chosen.fraction) tags['EXIF:SubSecTime' + suffix] = chosen.fraction;
    }
  }
  return { status: Object.keys(tags).length ? 'updated' : 'unchanged', tags, format,
    date: chosen.text, offset: chosen.zone, source: origin || fallback?.source, fallback: !origin };
}

const options = { fetch: () => fetch(new URL('./vendor/exiftool/zeroperl-mqcadjqm.wasm', import.meta.url)) };
async function metadata(file) {
  const result = await parseMetadata(file, { ...options, args: ['-j', '-G1', '-s', '-FileType', '-FileTypeExtension', '-DateTimeOriginal', '-CreateDate',
    '-DateCreated', '-TimeCreated', '-OffsetTimeOriginal', '-OffsetTimeDigitized', '-SubSecTimeOriginal', '-SubSecTimeDigitized'] });
  if (!result.success) throw new Error(result.error || 'Не удалось прочитать метаданные фотографии.');
  return JSON.parse(result.data)[0];
}
export async function processPhoto(blob, fallback) {
  if (blob.size > 128 * 1024 * 1024) return { status: 'unsupported', reason: 'Фото больше 128 МБ: даты сохранены только в JSON.', blob };
  const file = { name: 'photo.bin', data: blob };
  const before = await metadata(file), plan = photoDatePlan(before, fallback);
  if (plan.status !== 'updated') return { ...plan, blob };
  const result = await writeMetadata(file, plan.tags, options);
  if (!result.success) throw new Error(result.error || 'Не удалось записать даты фотографии.');
  const output = new Blob([result.data], { type: blob.type });
  const after = await metadata({ name: 'photo.bin', data: output });
  for (const [tag, value] of Object.entries(before)) {
    if (!tag.startsWith('Composite:') && parsePhotoDate(value) && after[tag] !== value) throw new Error('Проверка дат: существующая дата изменилась (' + tag + ').');
  }
  const verified = photoDatePlan(after, fallback);
  if (verified.status !== 'unchanged' || after['File:FileTypeExtension'] !== before['File:FileTypeExtension']) throw new Error('Проверка записанных дат не пройдена.');
  return { ...plan, blob: output };
}
