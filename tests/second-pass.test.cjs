// Regression coverage for the second-pass findings.
const { test } = require('node:test');
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const C = require('../cleaner-core.js');
const cfg = {INNERTUBE_API_KEY:'fake',INNERTUBE_CONTEXT:{},SESSION_INDEX:0};
const row = (id,pct) => ({playlistVideoRenderer:{setVideoId:id,videoId:id,thumbnailOverlays:[{thumbnailOverlayResumePlaybackRenderer:{percentDurationWatched:pct}}]}});
const page = items => ({contents:{playlistVideoListRenderer:{contents:items}}});
function adapter() {
  return {url:()=> 'https://www.youtube.com/playlist?list=WL',config:()=>cfg,cookies:()=> 'SAPISID=fake'};
}
function domFallback() {
  const rows = [];
  const ctx = vm.createContext({WLCCore:{...C,delay:async()=>{}},console,URL,
    window:{scrollBy(){},innerHeight:900},document:{querySelectorAll:()=>rows}});
  const source=fs.readFileSync(require.resolve('../content.js'),'utf8');
  vm.runInContext(source.slice(0,source.indexOf('  const cleaner ='))+`
    globalThis.fallback=fallback;
    rowInfo = row => row.info;
    removeRow = async row => { globalThis.deleted.push(row.info.key);rows.splice(rows.indexOf(row),1);return true; };
  })();`,ctx);
  ctx.rows=rows;ctx.deleted=[];
  return {fallback:ctx.fallback,rows,deleted:ctx.deleted};
}
test('container metadata prevents false completion before a matching third page', async () => {
    const parsed=C.parsePage({continuationContents:{playlistVideoListContinuation:{contents:[row('keep',0)],
      continuations:[{nextContinuationData:{continuation:'page3'}}]}}},true);
    assert.equal(parsed.continuation,'page3');
    // The engine must visit the matching third page and reject an unacknowledged edit.
    const a=adapter();let page3Requests=0;
    a.request=async(u,h,b)=>{
      if (!b.continuation)return page([{continuationItemRenderer:{continuationEndpoint:{continuationCommand:{token:'page2'}}}}]);
      if(b.continuation==='page3'){page3Requests++;return {continuationContents:{playlistVideoListContinuation:{contents:[row('unscanned-target',100)]}}};}
      return {continuationContents:{playlistVideoListContinuation:{contents:[row('keep',0)],continuations:[{nextContinuationData:{continuation:'page3'}}]}}};
    };
    const engine=new C.Cleaner(a);engine.start(80);await engine.task;
    assert.equal(engine.state.phase,'error');assert.ok(page3Requests > 0);
});
test('fallback cannot expand the API selection using stale DOM progress', async () => {
    const a=adapter(), dom=domFallback();
    for(const id of ['selected','keep'])dom.rows.push({info:{key:id,setVideoId:id,watchedPercent:100},scrollIntoView(){}});
    a.request=async url=>url.includes('edit_playlist')?{status:'STATUS_FAILED'}:page([row('selected',100),row('keep',0)]);
    a.fallback=dom.fallback;
    const engine=new C.Cleaner(a);engine.start(80);await engine.task;
    assert.deepEqual(dom.deleted,['selected']);
});
test('Stop preserves uncertainty during an outstanding native mutation', async () => {
    const a=adapter();let clicked;
    const clicking=new Promise(r=>clicked=r);
    a.request=async()=>{throw new Error('API unavailable')};
    a.fallback=async control=>{control.onMutation();clicked();await C.delay(5000,control.signal);return {failed:0};};
    const engine=new C.Cleaner(a);engine.start();await clicking;await engine.stop();
    assert.equal(engine.state.uncertain,true);assert.equal(engine.state.observed,0);assert.match(engine.state.message,/refresh to verify/);
});
test('an initial status snapshot cannot overwrite a newer running event', async () => {
    let ready,receive,releaseStatus;const elements={};
    const el=id=>elements[id] ||= {style:{},listeners:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},addEventListener(e,fn){this.listeners[e]=fn}};
    const idle={phase:'idle',running:false,count:0,observed:0};
    const running={...idle,phase:'removing',running:true,runId:1,message:'Removing…'};
    const context=vm.createContext({WLCCore:C,console,navigator:{},setTimeout(){},clearTimeout(){},window:{addEventListener(){}},
      document:{getElementById:el,addEventListener(e,fn){ready=fn}},
      browser:{storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{onMessage:{addListener(fn){receive=fn}}},tabs:{
        query:async()=>[{id:1,url:'https://www.youtube.com/playlist?list=WL'}],onUpdated:{addListener(){}},onActivated:{addListener(){}},
        sendMessage:async(id,m)=>m.command==='status'?new Promise(r=>releaseStatus=r):{ok:true}}}});
    vm.runInContext(fs.readFileSync(require.resolve('../popup.js'),'utf8'),context);
    const boot=ready();await new Promise(r=>setImmediate(r));
    receive({type:'state',state:running},{tab:{id:1}});
    assert.equal(elements.actionButton.textContent,'Stop');
    releaseStatus(idle);await boot;
    assert.equal(elements.actionButton.textContent,'Stop');
});
