// Self-contained metadata check: generated pixels, offline browser, temporary OPFS.
import { createRequire } from 'node:module';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createTestEnvironment, copyTestExtension } from '../tests/test-environment.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const workspace = await createTestEnvironment('photo-dates');
try {
  const extension = path.join(workspace.root, 'photo_downloader_smnv');
  await copyTestExtension(extension);
  const c = await workspace.launch(chromium, {
    executablePath: process.env.CHROMIUM_PATH || process.env.CHROME_PATH,
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  const s = await c.browser().newBrowserCDPSession();
  const { id } = await s.send('Extensions.loadUnpacked', { path: extension });
  const page = await c.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('chrome-extension://' + id + '/app.html');
  await page.evaluate(async () => { globalThis.photoProcessor = (await import('./photo-dates-client.js')).createPhotoDatesProcessor(); });
  const fixtures = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2468ac'; ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#9ace02'; ctx.fillRect(0, 0, 4, 4);
    return Promise.all(['image/jpeg', 'image/png', 'image/webp'].map(async mime => {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, mime));
      if (!blob || blob.type !== mime) throw Error('Synthetic image encoder unavailable');
      return { mime, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
    }));
  });
  for (const fixture of fixtures) {
    const result = await page.evaluate(async ({ mime, bytes }) => {
      const fallback = { date: '2020-02-03T12:00:00Z', source: 'vk.photo.date' };
      const first = await photoProcessor(new Blob([new Uint8Array(bytes)], { type: mime }), fallback);
      const second = await photoProcessor(first.blob, { ...fallback, date: '2025-06-07T08:00:00Z' });
      return { first: first.status, second: second.status, before: first.date, after: second.date };
    }, fixture);
    assert.equal(result.first, 'updated');
    assert.equal(result.second, 'unchanged');
    assert.equal(result.before, result.after, 'An existing date must be preserved');
    console.log(JSON.stringify({ format: fixture.mime, result: 'passed' }));
  }

const integration = await page.evaluate(async bytes => {
  let stage = 'setup';
  try {
  const {createDateManager}=await import('./date-manager.js');
  const {ydSourceDates,DATES_FILE}=await import('./source-dates.js');
  const {createRunner}=await import('./runner.js');
  const {findLocalFiles,saveLocalFile}=await import('./local-files.js');
  const fixtureRoot = await (await navigator.storage.getDirectory()).getDirectoryHandle('date-integration-fixture', { create: true });
  const root=await fixtureRoot.getDirectoryHandle('photo_downloader_smnv',{create:true}), dir=root;
  const read=async path=>{let parent=root;const parts=path.split('/');for(const p of parts.slice(0,-1))parent=await parent.getDirectoryHandle(p);return(await parent.getFileHandle(parts.at(-1))).getFile()};
  let manager,fetches=0,last;
  const resource={type:'dir',name:'Test Album',_embedded:{offset:0,total:1,items:[{type:'file',name:'photo.jpg',path:'/photo.jpg',size:bytes.length,media_type:'image',mime_type:'image/jpeg',created:'2020-02-03T12:00:00Z'}]}};
  manager=createDateManager({getDirectory:async()=>dir,getRoot:async()=>root,readLocal:read,resolveDate:async()=>{throw Error('Date should already be cached')}});
  const deps={loadJob:async()=>null,saveJob:async j=>{last=structuredClone(j)},resource:async job=>{await manager.capture(job,ydSourceDates(resource));return resource},
    getPhoto:async()=>{fetches++;return new Blob([new Uint8Array(bytes)],{type:'image/jpeg'})},
    findLocal:(job,file)=>findLocalFiles(root,job,file,manager.receipt),saveLocal:(path,blob,opts)=>saveLocalFile(root,path,blob,opts),
    preparePhoto:manager.prepare,afterSave:manager.afterSave,onDiscovered:manager.discovered};
  stage = 'first download';
  const first=createRunner(deps);await first.command('scan',{link:'https://disk.yandex.ru/d/test'});await first.waitUntilIdle();
  const firstState=await first.command('status');if(firstState.job.summary.originals!==1)throw Error('First download failed: '+JSON.stringify(last.files));
  stage = 'folder date JSON';
  const folderDates=JSON.parse(await(await read('yandex-disk/Test Album/'+DATES_FILE)).text());
  stage = 'global date JSON';
  const globalDates=JSON.parse(await(await read(DATES_FILE)).text());
  if(Object.keys(folderDates.dates).length!==1||Object.keys(globalDates.dates).length!==1)throw Error('Missing date JSON');
  stage = 'reuse';
  const second=createRunner(deps);await second.command('scan',{link:'https://disk.yandex.ru/d/test'});await second.waitUntilIdle();
  const state=await second.command('status');if(fetches!==1||state.job.summary.reused!==1)throw Error('Duplicate download or reuse failure');
  if(manager.snapshot().errors)throw Error(JSON.stringify(manager.snapshot()));
  return {fetches,reused:state.job.summary.reused,globalDates:Object.keys(globalDates.dates).length,folderDates:Object.keys(folderDates.dates).length,status:manager.snapshot()};
  } catch (error) { throw new Error('Date integration: ' + stage + ': ' + error.message); }
}, fixtures.find(fixture => fixture.mime === 'image/jpeg').bytes);
assert.deepEqual(errors, []);
console.log({ integration, result: 'passed' });
} finally { await workspace.close(); }
