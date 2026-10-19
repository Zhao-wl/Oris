// 无界面 Edge + CDP，仅操作本轮创建的进程与独立 profile，不调用原生窗口 API。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { connectCdp, sleep } from "./perf/gui-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "artifacts", "aligned-scroll");
const args = process.argv.slice(2);
const option = name => { const i=args.indexOf(name); return i<0?null:args[i+1]; };
const repo = option('--repo'), file = option('--file');
let feedback = null;
if (repo && file) {
  const index = spawnSync('git',['-C',repo,'show',`:${file}`],{encoding:'utf8',windowsHide:true});
  assert.equal(index.status,0,index.stderr);
  feedback = {left:index.stdout.replace(/\r\n?/g,'\n'),right:readFileSync(path.join(repo,file),'utf8').replace(/\r\n?/g,'\n')};
}
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), "oris-aligned-scroll-"));
const edge = process.env.ORIS_TEST_BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
assert.ok(existsSync(edge), `缺少浏览器：${edge}`);
// 独立配置/缓存：并行 tsc 生成 vite.config.js 时不能重启测试服务器、丢失夹具路由。
const server = await createServer({ root, configFile: false, plugins: [react({ include: /\/src\/.*\.[jt]sx?$/ })], cacheDir: path.join(output, 'vite-cache'),
  server: { port: 0, strictPort: false, host: "127.0.0.1" } });
server.middlewares.use("/__aligned_scroll", async (req, res, next) => {
  if (req.url.includes('html-proxy')) return next();
  res.setHeader("Content-Type", "text/html");
  res.end(await server.transformIndexHtml("/__aligned_scroll", `<!doctype html><html><body>
    <div id="root" style="height:720px;width:1500px"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {EditorView} from '@codemirror/view';
    import DiffViewer from '/src/DiffViewer.tsx';
    import {computeDiff} from '/src/diff-core.ts';
    import '/src/styles.css';
    const root = createRoot(document.getElementById('root'));
    const noop = () => {};
    let id = 0;
    window.mountDiff = (fixture, options = {}) => {
      const base = Array.from({length: fixture === 'short' || fixture === 'blank' ? 64 : 1200}, (_, i) => 'const item' + i + ' = load(' + i + ');');
      if (fixture === 'blank') base[46] = '';
      const changed = [...base];
      if (fixture === 'wrapped') for (let i = 55; i < base.length; i += 80) base[i] = changed[i] = base[i] + ' // ' + 'context '.repeat(60);
      changed.splice(fixture === 'short' || fixture === 'blank' ? 47 : 100, 0, ...Array.from({length:24}, (_, i) => fixture === 'blank' && i === 23 ? '' : '// inserted ' + i));
      if (fixture === 'blank') changed.splice(37,0,'// extra 1','// extra 2','// extra 3');
      if (fixture === 'deleted') base.splice(600, 0, ...Array.from({length:40}, (_, i) => '// removed ' + i));
      if (fixture === 'eof') changed.push(...Array.from({length:12}, (_, i) => '// appended ' + i));
      const feedback = ${JSON.stringify(feedback)};
      const left = fixture === 'feedback' ? feedback.left : base.join('\\n') + (options.noNewline ? '' : '\\n'), right = fixture === 'feedback' ? feedback.right : changed.join('\\n') + (options.noNewline ? '' : '\\n');
      const document = {requestId: String(++id), contentIds: ['a'+id, 'b'+id], ...computeDiff(left, right), elapsedMs:0};
      root.render(React.createElement(DiffViewer, {readingKey:String(id), presentation:{kind:'compare'},
        left,right,document,mode:'split',highlight:'words',collapsed:!!options.collapsed,wrap:!!options.wrap,alignChanges:options.aligned !== false,
        hunkHeaders:options.headers?{items:document.hunks.map((_,index)=>({index,state:'ready'})),actions:[],disabledReason:null,onAction:noop,onIntent:noop}:null,
        onPositionChange:noop,onSplitLayoutChange:noop}));
    };
    window.views = () => [...document.querySelectorAll('.cm-editor')].map(n => EditorView.findFromDOM(n));
    window.snapshot = () => {
      const views = window.views();
      const scrollers = views.map(v => v.scrollDOM);
      const rows = scrollers.map(sc => [...sc.querySelectorAll('.cm-line')].map(el => ({text:el.textContent, y:el.getBoundingClientRect().top, bottom:el.getBoundingClientRect().bottom})).filter(r=>r.bottom > sc.getBoundingClientRect().top && r.y < sc.getBoundingClientRect().bottom));
      const pairs = rows[0].filter(a=>a.text.trim() && rows[0].filter(r=>r.text===a.text).length===1 && rows[1].filter(r=>r.text===a.text).length===1).map(a=>Math.abs(a.y-rows[1].find(b=>b.text===a.text).y));
      const connectors = [...document.querySelectorAll('.diff-connectors path')].map(p=>({...p.dataset}));
      return {tops:scrollers.map(sc=>sc.scrollTop), max:scrollers.map(sc=>sc.scrollHeight-sc.clientHeight),
        pairs:pairs.length,error:pairs.length?Math.max(...pairs):null,master:document.querySelector('.oris-split-view').dataset.masterSide,
        ready:document.querySelector('.oris-split-view').dataset.alignmentReady,
        generation:document.querySelector('.oris-split-view').dataset.alignmentGeneration,
        spacers:views.map(v=>{ let count=0; for(const set of v.state.facet(EditorView.decorations)) if(typeof set !== 'function') set.between(0,v.state.doc.length,(_a,_b,deco)=>{if(deco.spec.widget?.constructor.name==='AlignmentSpacer')count++;}); return count; }),
        connectors};
    };
    </script></body></html>`));
});
// 注册在 Vite 的 SPA fallback 之前。
server.middlewares.stack.unshift(server.middlewares.stack.pop());
await server.listen();
console.log('headless server ready');
const url = `http://127.0.0.1:${server.httpServer.address().port}/__aligned_scroll`;
const browser = spawn(edge, ["--headless=new", "--guest", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1600,850", url], { windowsHide: true, stdio: "ignore" });
let cdp;
const samples = [];
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
try {
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i=0; !existsSync(portFile) && i<200; i++) await sleep(50);
  const port = Number(readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
  let target;
  for (let i=0; i<200; i++) {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type === 'page' && t.url === url);
    if (target) break;
    await sleep(50);
  }
  assert.ok(target, '本轮页面未创建');
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', e => console.error('browser exception',JSON.stringify(e)));
  cdp.on('Log.entryAdded', e => console.error('browser log',e.entry.text));
  await cdp.call('Runtime.enable');
  await cdp.call('Log.enable');
  console.log('headless CDP connected');
  await cdp.waitFor("typeof window.mountDiff === 'function'", 90000);
  const settle = async () => { await sleep(800); await cdp.waitFor("document.querySelector('.oris-split-view')?.dataset.alignmentReady === 'true'"); await sleep(150); };
  const capture = async (label) => { const state = await cdp.evaluate('window.snapshot()'); samples.push({label,...state}); console.log(label, JSON.stringify(state)); return state; };
  for (const [fixture,options] of (feedback ? [['feedback',{}],['feedback',{headers:true}],['feedback',{wrap:true}]] : [['short',{}],['blank',{}],['eof',{}],['eof',{noNewline:true}],['deleted',{}],['wrapped',{wrap:true}],['short',{collapsed:true}],['short',{aligned:false}]])) {
    const name = fixture + JSON.stringify(options);
    await cdp.evaluate(`window.mountDiff(${JSON.stringify(fixture)},${JSON.stringify(options)})`);
    await settle();
    for (const side of [0,1]) {
      await cdp.evaluate(`(() => { const sc=window.views()[${side}].scrollDOM; sc.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); sc.scrollTop=0; })()`);
      await settle();
      // 浏览器原生滚轮输入，逐帧记录滚动方向、主控侧和占位是否被清空。
      await cdp.evaluate(`(() => { window.trace=[]; window.record=true; const tick=()=>{ if(!window.record)return; window.trace.push(window.snapshot()); requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
      const point = await cdp.evaluate(`(() => { const r=window.views()[${side}].scrollDOM.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+100}; })()`);
      for (let i=0;i<10;i++) { await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:90}); await sleep(35); }
      await settle();
      const state = await capture(`${name} side=${side} wheel`);
      const trace = await cdp.evaluate('window.record=false; window.trace');
      if (options.aligned !== false) {
        check(state.tops[side]>=Math.min(200,state.max[side]), `${name} side=${side} 滚轮未前进`);
        check(!trace.some(t=>t.spacers[0]+t.spacers[1] === 0), `${name} side=${side} 滚轮清空占位`);
        check(!trace.some((t,i)=>i>0 && t.tops[side] < trace[i-1].tops[side]-2), `${name} side=${side} 滚动回跳`);
        check(state.master === (side === 0 ? 'a' : 'b'), `${name} side=${side} 主控被回声接管`);
        await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-180});
        await settle();
        const up = await capture(`${name} side=${side} reverse`);
        check(up.tops[side]<state.tops[side], `${name} side=${side} 向上滚动卡住`);
        if (up.max[side]>200) {
          await cdp.evaluate(`window.views()[${1-side}].scrollDOM.scrollTop += 30`);
          await settle();
          const anchored = await cdp.evaluate('window.snapshot()');
          check(Math.abs(anchored.tops[side]-up.tops[side])<=1 && Math.abs(anchored.tops[0]-anchored.tops[1])<=1,
            `${name} side=${side} 从属侧测量后未恢复同步`);
        }
      }
      await cdp.evaluate(`window.views()[${side}].scrollDOM.scrollTop=1e9`);
      await settle();
      const bottom = await capture(`${name} side=${side} bottom`);
      if (options.aligned !== false) {
        check(bottom.pairs>0 && bottom.error<=1, `${name} side=${side} 底部错位 ${bottom.error}px`);
        check(bottom.connectors.every(p=>Math.abs(Number(p.aPaintBottom)-Number(p.bPaintBottom))<=1), `${name} side=${side} 色块下边缘错位`);
      }
      if (feedback && !options.headers && !options.wrap && side===1) writeFileSync(path.join(output,'feedback-after.png'),await cdp.screenshot());
    }
  }
  writeFileSync(path.join(output,feedback?'feedback-result.json':'result.json'), JSON.stringify({method:'headless Edge native CDP wheel / DOM layout; no Windows focus test',samples,failures},null,2));
  assert.deepEqual(failures,[]);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (cdp) { await Promise.race([cdp.call('Browser.close').catch(()=>{}),sleep(1000)]); cdp.close(); }
  if (browser.exitCode === null) await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),sleep(5000)]);
  if (browser.exitCode === null) browser.kill();
  server.httpServer.closeAllConnections();
  await server.close();
  for (let i=0;i<20;i++) { try { rmSync(profile,{recursive:true,force:true}); break; } catch { await sleep(100); } }
}
