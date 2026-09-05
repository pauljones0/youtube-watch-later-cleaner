// Review reproductions: assertions describe the bugs in v2.4, not desired behavior.
// No network or real playlist mutations. Run: node review/reproduce.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = require('node:child_process').execFileSync('git', ['show', 'be4a77f:content.js'], {cwd:root, encoding:'utf8'});
let passed = 0;
function load() {
  const messages = [], timers = [];
  const byline = {textContent:'100 videos'};
  const document = {cookie:'SAPISID=fake', querySelector: s => s.includes('byline') ? byline : null,
    querySelectorAll:s => s.includes('byline') ? [byline] : [], body:{click(){}}};
  const c = vm.createContext({console:{log(){},warn(){},error(){}}, document, URL, TextEncoder,
    crypto:require('node:crypto').webcrypto, navigator:{userAgent:'review'},
    setTimeout(fn,ms){timers.push({fn,ms}); if(ms !== 15000) queueMicrotask(fn); return timers.length},
    clearTimeout(){}, cloneInto:x=>x,
    browser:{runtime:{getManifest:()=>({version:'2.4'}),sendMessage:async m=>messages.push(m),
      onMessage:{addListener(fn){c.listener=fn}}}},
    window:{location:{href:'https://www.youtube.com/playlist?list=WL',origin:'https://www.youtube.com'},
      wrappedJSObject:{ytcfg:{data_:{INNERTUBE_API_KEY:'fake',INNERTUBE_CONTEXT:{client:{}},SESSION_INDEX:2,DELEGATED_SESSION_ID:'brand'}}}}});
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.review = code => eval(code);\n})();'), c);
  return {c,run:code=>c.window.review(code),messages,timers,byline};
}
async function test(name,fn){await fn();passed++;console.log('REPRODUCED:',name)}
(async()=>{
  await test('account routing ignores active account and brand',async()=>{
    const {run}=load(); const h=run('getApiHeaders("fake")');
    assert.equal(h['X-Goog-AuthUser'],'0'); assert.equal(h['X-Goog-PageId'],undefined);
    assert.equal(run('getYtConfig().sessionIndex'),undefined);
  });
  await test('HTTP 403 JSON is parsed as a successful empty playlist',async()=>{
    const {c,run}=load(); c.window.wrappedJSObject.fetch=async()=>({status:403,text:async()=>JSON.stringify({error:{code:403,message:'Forbidden'}})});
    const p=await run('fetchPlaylistPage("fake",getYtConfig(),null)');
    assert.equal(p.error,null);assert.equal(p.videos.length,0);
  });
  await test('unrecognized response layout is accepted as empty',async()=>{
    const {run}=load();run('pageFetch = async () => ({onResponseReceivedEndpoints:[{appendContinuationItemsAction:{continuationItems:[{playlistVideoRenderer:{setVideoId:"still-there"}}]}}]})');
    const p=await run('fetchPlaylistPage("fake",getYtConfig(),"token")');
    assert.equal(p.error,null);assert.equal(p.videos.length,0);
  });
  await test('failed verification counts an unremoved batch as deleted',async()=>{
    const {run,c}=load();
    run(`window.cleanerIsRunning=true; let n=0;
      waitForYouTubeReady=async()=>getYtConfig(); generateSapisidHash=async()=>"fake";
      fetchPlaylistPage=async()=> ++n===1 ? {videos:[{setVideoId:'a',watchedPercent:0}],continuation:null} : {videos:[],continuation:null,error:'timeout'};
      batchRemoveVideos=async()=>({ok:false,error:'timeout'});
      reconcilePlaylistAfterBatch=async()=>{};`);
    await run('cleanAllAPI()');
    assert.equal(c.window.cleanerState.count,1); assert.equal(c.window.cleanerState.done,true);
  });
  await test('a browse error terminates filtered cleaning as success',async()=>{
    const {run,c}=load();
    run(`window.cleanerIsRunning=true; window.cleanerState.settings={minProgressPercent:80}; let n=0;
      waitForYouTubeReady=async()=>getYtConfig(); generateSapisidHash=async()=>"fake";
      fetchPlaylistPage=async()=> ++n===1 ? {videos:[{setVideoId:'keep',watchedPercent:0}],continuation:'next'} : {videos:[],continuation:null,error:'timeout'};`);
    await run('cleanAllAPI()'); assert.equal(c.window.cleanerState.done,true);assert.equal(c.window.cleanerState.count,0);
  });
  await test('Stop still sends the second delete chunk',async()=>{
    const {run,c}=load(); c.calls=[];
    run(`window.cleanerIsRunning=true;
      waitForYouTubeReady=async()=>getYtConfig(); generateSapisidHash=async()=>"fake";
      fetchPlaylistPage=async()=>({videos:Array.from({length:101},(_,i)=>({setVideoId:String(i),watchedPercent:0})),continuation:null});
      batchRemoveVideos=async(a,b,ids)=>{calls.push(ids.length);window.cleanerIsRunning=false;return {ok:true}};
      reconcilePlaylistAfterBatch=async()=>{};`);
    await run('cleanAllAPI()');assert.deepEqual(c.calls,[100,1]);
  });
  await test('page fetch timeout does not abort the underlying request',async()=>{
    const {run,c,timers}=load();let finish,options;
    c.window.wrappedJSObject.fetch=(u,o)=>{options=o;return new Promise(r=>finish=r)};
    const p=run('pageFetch("https://www.youtube.com/fake",{},"{}")');
    timers.find(t=>t.ms===15000).fn();await assert.rejects(p,/timeout/);
    assert.equal(options.signal,undefined);finish({status:200,text:async()=>'{"status":"STATUS_SUCCEEDED"}'});
  });
  await test('UI count decremented twice after YouTube already updated it',async()=>{
    const {run,byline}=load();byline.textContent='99 videos';
    const check=await run('confirmFallbackRemoval({videoId:"a"},null,100)');assert.equal(check.ok,true);
    run('requestHydrationTopUp=async()=>({})');await run('reconcileAfterSingleVisibleRemoval()');
    assert.equal(byline.textContent,'98 videos');
  });
  await test('UI verification accepts absence after only 20 of 21 pages',async()=>{
    const {run}=load(); run('fetchPlaylistPage=async()=>({videos:[],continuation:"next",error:null})');
    const r=await run('confirmFallbackRemoval({videoId:"on-page-21"},{auth:"fake",ytcfg:{}},100)');
    assert.equal(r.ok,true);assert.equal(r.verification.completed,false);assert.equal(r.verification.pagesScanned,20);
  });
  await test('localized counts are truncated and French count cannot be updated',async()=>{
    const {run,byline}=load();assert.equal(run('parseCountFromText("1.234 videos")'),1);
    assert.equal(run('parseCountFromText("1 234 vidéos")'),1);
    byline.textContent='100 vidéos';run('reconcilePlaylistRemovalCount(100)');assert.equal(byline.textContent,'100 vidéos');
  });
  await test('a positional fallback clicks an unidentified third menu action',async()=>{
    const {run,c}=load();let clicks=0;const row={isConnected:true,querySelector:()=>({click(){}})};
    c.row=row;c.document.querySelector=s=>s.includes(':nth-child(3)')?{click(){clicks++;row.isConnected=false}}:s.includes('listbox')?{}:null;
    c.document.querySelectorAll=()=>[];
    const r=await run('removeVideoViaMenu(row)');assert.equal(clicks,1);assert.equal(r.ok,true);
  });
  await test('zero DOM rows with a known nonempty playlist finishes successfully',async()=>{
    const {run,c}=load();run(`window.cleanerIsRunning=true;ensureHydrationApiContext=async()=>({error:'no-auth'});
      showHiddenVideosUI=async()=>{};scrollForMoreRows=async()=>false;`);
    await run('cleanFallbackUI(0)');assert.equal(c.window.cleanerState.done,true);assert.equal(c.window.cleanerState.remaining,100);
  });
  await test('an old run can delete and overwrite state after Stop then Start',async()=>{
    const {run,c}=load();let release; c.gate=new Promise(r=>release=r); c.calls=[];
    run(`window.cleanerIsRunning=true;
      waitForYouTubeReady=async()=>getYtConfig(); generateSapisidHash=async()=>"fake";
      fetchPlaylistPage=async()=>await gate;
      batchRemoveVideos=async(a,b,ids)=>{calls.push(...ids);window.cleanerIsRunning=false;return {ok:true}};
      reconcilePlaylistAfterBatch=async()=>{};`);
    const old=run('cleanAllAPI()');await new Promise(r=>setImmediate(r));
    c.listener({command:'stop'},{},()=>{});
    // Equivalent new-run state: the prior task is still awaiting the old request.
    run('window.cleanerIsRunning=true; window.cleanerState=createCleanerState({running:true,settings:{minProgressPercent:100}})');
    release({videos:[{setVideoId:'old-unwatched-target',watchedPercent:0}],continuation:null});await old;
    assert.deepEqual(c.calls,['old-unwatched-target']);assert.equal(c.window.cleanerState.count,1);
  });
  await test('menu removal still operates after SPA navigation to another playlist',async()=>{
    const {run,c}=load();let clicks=0;const row={isConnected:true,querySelector:()=>({click(){}})};
    c.row=row;c.window.location.href='https://www.youtube.com/playlist?list=OTHER';
    c.document.querySelector=s=>s.includes(':nth-child(3)')?{click(){clicks++;row.isConnected=false}}:s.includes('listbox')?{}:null;
    c.document.querySelectorAll=()=>[];
    await run('removeVideoViaMenu(row)');assert.equal(clicks,1);
  });
  await test('old completion timer destroys a newly started overlay',async()=>{
    const {run,c}=load();const scheduled=[];c.setTimeout=(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length};
    run(`overlayRefs={barFill:{classList:{remove(){},add(){}},style:{}},count:{},label:{},dot:{classList:{add(){}}},toast:{classList:{add(){}}}}`);
    run('completeOverlay(1,1)');scheduled[0].fn();
    run('destroyOverlay(); overlayHost={remove(){window.newOverlayRemoved=true}}; overlayRefs={newRun:true}');
    scheduled[1].fn();assert.equal(c.window.newOverlayRemoved,true);assert.equal(run('overlayRefs'),null);
  });
  console.log(`${passed} content reproductions passed.`);
})().catch(e=>{console.error(e);process.exitCode=1});
