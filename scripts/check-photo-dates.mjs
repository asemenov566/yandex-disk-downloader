import {createRequire} from 'node:module';import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';import path from 'node:path';
const require=createRequire(import.meta.url);const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const c=await chromium.launchPersistentContext(path.resolve('test-output/photo-dates-browser-'+Date.now()),{executablePath:process.env.CHROME_PATH,headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
try{const s=await c.browser().newBrowserCDPSession();const {id}=await s.send('Extensions.loadUnpacked',{path:path.resolve('photo_downloader_smnv')});const page=await c.newPage();let errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('chrome-extension://'+id+'/app.html');
await page.evaluate(async()=>{globalThis.photoProcessor=(await import('./photo-dates-client.js')).createPhotoDatesProcessor()});
const folder='test-output/photo-date-fixtures';await mkdir(folder+'/out',{recursive:true});
for(const name of (await readdir(folder)).filter(n=>n.includes('.'))){const started=Date.now();const result=await page.evaluate(async({name,bytes})=>{
const b=new Blob([new Uint8Array(bytes)],{type:name.endsWith('jpg')?'image/jpeg':'application/octet-stream'});
const r=await photoProcessor(b,{date:'2020-02-03T12:00:00Z',source:'vk.photo.date'});
return {...r,blob:undefined,bytes:[...new Uint8Array(await r.blob.arrayBuffer())]};
},{name,bytes:[...await readFile(folder+'/'+name)]});await writeFile(folder+'/out/'+name,Buffer.from(result.bytes));delete result.bytes;console.log(JSON.stringify({name,ms:Date.now()-started,...result}));}

const integration = await page.evaluate(async bytes => {
  const {createDateManager}=await import('./date-manager.js');
  const {ydSourceDates,DATES_FILE}=await import('./source-dates.js');
  const {createRunner}=await import('./runner.js');
  const {findLocalFiles,saveLocalFile}=await import('./local-files.js');
  const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('photo_downloader_smnv',{create:true}), dir=root;
  const read=async path=>{let parent=root;const parts=path.split('/');for(const p of parts.slice(0,-1))parent=await parent.getDirectoryHandle(p);return(await parent.getFileHandle(parts.at(-1))).getFile()};
  let manager,fetches=0,last;
  const resource={type:'dir',name:'Test Album',_embedded:{offset:0,total:1,items:[{type:'file',name:'photo.jpg',path:'/photo.jpg',size:bytes.length,media_type:'image',mime_type:'image/jpeg',created:'2020-02-03T12:00:00Z'}]}};
  manager=createDateManager({getDirectory:async()=>dir,getRoot:async()=>root,readLocal:read,resolveDate:async()=>{throw Error('Date should already be cached')}});
  const deps={loadJob:async()=>null,saveJob:async j=>{last=structuredClone(j)},resource:async job=>{await manager.capture(job,ydSourceDates(resource));return resource},
    getPhoto:async()=>{fetches++;return new Blob([new Uint8Array(bytes)],{type:'image/jpeg'})},
    findLocal:(job,file)=>findLocalFiles(root,job,file,manager.receipt),saveLocal:(path,blob,opts)=>saveLocalFile(root,path,blob,opts),
    preparePhoto:manager.prepare,afterSave:manager.afterSave,onDiscovered:manager.discovered};
  const first=createRunner(deps);await first.command('scan',{link:'https://disk.yandex.ru/d/test'});await first.waitUntilIdle();
  const firstState=await first.command('status');if(firstState.job.summary.originals!==1)throw Error('First download failed: '+JSON.stringify(last.files));
  const folderDates=JSON.parse(await(await read('yandex-disk/Test Album/'+DATES_FILE)).text());
  const globalDates=JSON.parse(await(await read(DATES_FILE)).text());
  if(Object.keys(folderDates.dates).length!==1||Object.keys(globalDates.dates).length!==1)throw Error('Missing date JSON');
  const second=createRunner(deps);await second.command('scan',{link:'https://disk.yandex.ru/d/test'});await second.waitUntilIdle();
  const state=await second.command('status');if(fetches!==1||state.job.summary.reused!==1)throw Error('Duplicate download or reuse failure');
  if(manager.snapshot().errors)throw Error(JSON.stringify(manager.snapshot()));
  return {fetches,reused:state.job.summary.reused,globalDates:Object.keys(globalDates.dates).length,folderDates:Object.keys(folderDates.dates).length,status:manager.snapshot()};
},[...await readFile(folder+'/plain.jpg')]);
console.log({integration});
console.log({pageErrors:errors});await page.screenshot({path:'test-output/photo-dates-ui.png'});
}finally{await c.close()}
