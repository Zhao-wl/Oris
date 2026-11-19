// No native windows: render captured React markup with production CSS in isolated headless Edge.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const output = resolve(process.env.ORIS_LAYOUT_SNAPSHOTS || 'artifacts/layout-0.9.5');
process.env.ORIS_LAYOUT_SNAPSHOTS = output;
const { startVitest } = await import('vitest/node');
let runner;
try {
 runner = await startVitest('test', ['src/App.operations.test.tsx','src/App.history.test.tsx'], {run:true,maxWorkers:1,testNamePattern:'初次加载|resizes the side columns',setupFiles:['scripts/issue36-layout-setup.mjs']});
 if (!runner || runner.state.getUnhandledErrors().length || runner.state.getFiles().some(file=>file.result?.state==='fail')) throw new Error('DOM capture failed');
} finally { await runner?.close(); }
const {chromium} = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.launch({channel:'msedge',headless:true});
const results=[];
try {
 const page=await browser.newPage();
 await page.route('**/*', route=>route.abort());
 for(const [width,height] of [[1920,1080],[1280,820],[900,600]]) {
  await page.setViewportSize({width,height});
  await page.setContent(readFileSync(join(output,'sidebar.html'),'utf8'));
  await page.evaluate(()=>{document.body.firstElementChild.id='root';});
  await page.addStyleTag({content:readFileSync('src/styles.css','utf8')+'\n'+readFileSync('src/ai-input.css','utf8')});
  const layout=await page.evaluate(()=>{
   const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
   return {top:box('.titlebar'),projects:box('.projectbar'),reader:box('.workspace'),dock:box('.git-panel'),first:box('.change-column:first-child'),second:box('.change-column:nth-child(2)'),composer:box('.commit-layout'),list:box('.change-column .files'),tabs:[...document.querySelectorAll('.git-tabs [role=tab]')].map(e=>e.getBoundingClientRect().height),toolbarHidden:document.querySelector('.toolbar')?.hidden??true,bodyWidth:document.body.scrollWidth};
  });
  assert.equal(layout.reader.width,width);assert.equal(layout.top.height,39);assert.equal(layout.projects.height,35);
  assert.equal(layout.tabs[0],layout.tabs[1]);assert.ok(layout.list.height>90,JSON.stringify(layout));
  assert.ok(layout.first.right<=layout.second.x+1);assert.ok(layout.second.right<=layout.composer.x+1);
  assert.ok(layout.composer.right<=width+1);assert.ok(layout.reader.height>=100);assert.equal(layout.toolbarHidden,true);
  assert.equal(layout.bodyWidth,width);results.push({width,height,layout});
  await page.screenshot({path:join(output,`files-${width}.png`)});

  const pushFailure = await page.evaluate(() => {
   const statusbar = document.querySelector('.statusbar');
   const message = document.createElement('button');
   message.className = 'op-status failed';
   message.textContent = '✗ 推送 dev_X15-2978 到 origin/dev_X15-2978 被拒绝\n' + 'remote: 更新远端引用失败。'.repeat(80);
   const pull = document.createElement('button');
   pull.className = 'op-undo push-rejected-pull';
   pull.textContent = '拉取';
   statusbar.lastElementChild.before(message, pull);
   return {
    readerWidth: document.querySelector('.workspace').getBoundingClientRect().width,
    composerRight: document.querySelector('.commit-layout').getBoundingClientRect().right,
    statusbarWidth: statusbar.getBoundingClientRect().width,
    pullRight: pull.getBoundingClientRect().right,
    messageTruncated: message.scrollWidth > message.clientWidth,
   };
  });
  assert.equal(pushFailure.readerWidth,width);
  assert.equal(pushFailure.statusbarWidth,width);
  assert.ok(pushFailure.composerRight<=width && pushFailure.pullRight<=width);
  assert.ok(pushFailure.messageTruncated);
  results.at(-1).pushFailure = pushFailure;
 }
 await page.setViewportSize({width:1920,height:1080});
 await page.setContent(readFileSync(join(output,'history.html'),'utf8'));
 await page.evaluate(()=>{document.body.firstElementChild.id='root';const panel=document.querySelector('.log-layout');panel.style.gridTemplateColumns='288px 5px minmax(0,1fr) 5px 672px';});
 await page.addStyleTag({content:readFileSync('src/styles.css','utf8')});
 const history=await page.evaluate(()=>{const panel=document.querySelector('.log-layout'), dock=document.querySelector('.git-panel');return {height:panel.getBoundingClientRect().height,dockHeight:dock.getBoundingClientRect().height,columns:getComputedStyle(panel).gridTemplateColumns};});
 assert.ok(history.height>200);assert.ok(history.height<history.dockHeight);results.push({history,method:'real React history markup; columns set to 1920px default because DOM capture uses jsdom 1024px viewport'});
 await page.screenshot({path:join(output,'history-1920.png')});
 writeFileSync(join(output,'report.json'),JSON.stringify({method:'Captured React DOM + real CSS, isolated headless Edge; mocked Git data',nativeWindowsFocus:'not tested',results},null,2));
 console.log('Layout checks passed for 1920, 1280 and 900px');
} finally {await browser.close();}
