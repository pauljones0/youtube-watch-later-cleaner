// Isolated v2.4 popup bug reproductions; no actual browser APIs or network.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const source=require('node:child_process').execFileSync('git',['show','be4a77f:popup.js'],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
const flush=()=>new Promise(r=>setImmediate(r));
async function load({loading=false,stored={},rejectStart=false}={}) {
  const elements={},timers=[],sent=[];let ready,receive;
  function element(id){return elements[id] ||= {textContent:'',value:'0',disabled:false,style:{},className:'',listeners:{},
    classList:{values:new Set(),add(...x){x.forEach(v=>this.values.add(v))},remove(...x){x.forEach(v=>this.values.delete(v))},toggle(x,b){if(b)this.add(x);else this.remove(x)},contains(x){return this.values.has(x)}},
    addEventListener(n,fn){this.listeners[n]=fn},setAttribute(){}}}
  const document={getElementById:element,addEventListener(n,fn){ready=fn},querySelector(s){
    if(loading)return s==='ytd-playlist-header-renderer'?{}:null;
    return s.includes('byline')?{textContent:'100 videos'}:null;
  }};
  const state={running:false,done:false,count:0,total:100,remaining:100};
  const c=vm.createContext({document,console,URL,navigator:{},setTimeout(fn,ms){timers.push({fn,ms});return timers.length},clearTimeout(){},
    window:{addEventListener(){}}, browser:{
      storage:{local:{get:async()=>stored,set:async()=>{},remove:async()=>{}}},
      tabs:{query:async()=>[{id:1,url:'https://www.youtube.com/playlist?list=WL'}],
        executeScript:async(id,o)=>o.code?[vm.runInContext(o.code,c)]:[],
        sendMessage:async(id,m)=>{sent.push(m);if(m.command==='status')return state;
          if(m.command==='start' && rejectStart)receive({type:'error',text:'Please sign in to YouTube first.'},{tab:{id}});
          if(m.command==='stop')receive({type:'log',text:'Stopped.',class:'warning'},{tab:{id}});
          return undefined},onUpdated:{addListener(){}},create:async()=>{},update:async()=>{}},
      runtime:{getManifest:()=>({version:'2.4'}),onMessage:{addListener(fn){receive=fn}}}}});
  vm.runInContext(source.replace(/\}\);\s*$/,'window.review = code => eval(code);\n});'),c);
  await ready();await flush();await flush();
  return {c,e:elements,timers,sent,receive,run:x=>c.window.review(x)};
}
(async()=>{
  {
    const {e}=await load();await e.actionButton.listeners.click();assert.equal(e.actionButton.textContent,'Stop');
    await e.actionButton.listeners.click();assert.equal(e.actionButton.disabled,true);
    assert.equal(e.actionButton.textContent,'Stop');console.log('REPRODUCED: Stop leaves popup permanently disabled');
  }
  {
    const {e,receive}=await load();receive({type:'complete',count:999,remaining:0},{tab:{id:999}});
    assert.equal(e.actionButton.classList.contains('hidden'),true);
    assert.match(e.status.textContent,/999/);console.log('REPRODUCED: another tab completion hides current tab controls');
  }
  {
    const {e,sent}=await load({stored:{cleanerSettings:{sliderThreshold:80,advancedOpen:true}}});
    e.advancedToggle.listeners.click();await e.actionButton.listeners.click();
    assert.equal(sent.find(m=>m.command==='start').settings.minProgressPercent,0);
    assert.equal(e.progressThresholdValue.textContent,'80%');console.log('REPRODUCED: collapsing Advanced changes 80% filter to delete everything');
  }
  {
    const {e,timers}=await load({loading:true});assert.equal(e.actionButton.classList.contains('hidden'),true);
    assert.equal(e.status.textContent,'Nothing to clean!');assert.equal(timers.length,0);
    console.log('REPRODUCED: loading playlist header is treated as permanently empty');
  }
  {
    const {run}=await load();assert.equal(run('isWatchLaterUrl("https://www.youtube.com/playlist?foo=1&list=WL")'),false);
    assert.equal(run('isWatchLaterUrl("https://www.youtube.com/playlist?list=WLother")'),true);
    console.log('REPRODUCED: URL check rejects reordered queries and accepts wrong playlist IDs');
  }
  {
    const counts=Array(101).fill(5);counts[0]=100;
    const {e,sent}=await load({stored:{cleanerSettings:{sliderThreshold:80,advancedOpen:true},
      cleanerPreviewHistogram:{total:100,countsAtLeast:counts,savedAt:Date.now()}}});
    assert.equal(e.count.textContent,'5');assert.equal(sent.some(m=>m.command==='estimate'),false);
    console.log('REPRODUCED: same-size different account/list reuses global preview without validation');
  }
  {
    const {e}=await load({rejectStart:true});await e.actionButton.listeners.click();
    assert.equal(e.actionButton.textContent,'Stop');assert.equal(e.status.textContent,'Cleaning in progress...');
    console.log('REPRODUCED: a rejected Start can be overwritten by optimistic running UI');
  }
  console.log('7 popup reproductions passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
