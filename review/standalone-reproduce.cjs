// Load the console script's actual functions while suppressing its auto-start.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const text=require('node:child_process').execFileSync('git',['show','be4a77f:removeWatchLater.js'],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
const prefix=text.slice(0,text.indexOf('  (async () => {'));
const timers=new Map();let seq=0,finishBody;
const c=vm.createContext({console,URL,TextEncoder,AbortController,
  setTimeout(fn){timers.set(++seq,fn);return seq},clearTimeout(id){timers.delete(id)},
  window:{location:{href:'https://www.youtube.com/playlist?list=WL'},ytcfg:{data_:{INNERTUBE_API_KEY:'fake',INNERTUBE_CONTEXT:{}}}},
  fetch:async()=>({json:()=>new Promise(resolve=>finishBody=resolve)}),
});
vm.runInContext(prefix+'window.review = code=>eval(code);})();',c);
(async()=>{
  const p=c.window.review('fetchPage("fake",null)');let settled=false;p.finally(()=>settled=true);
  await new Promise(r=>setImmediate(r));
  assert.equal(timers.size,0);assert.equal(settled,false);
  finishBody({});await p;
  console.log('REPRODUCED: console-script timeout ends at headers; a stalled JSON body hangs forever');
  c.fetch=async()=>({status:403,json:async()=>({error:{code:403}})});
  const r=await c.window.review('fetchPage("fake",null)');assert.equal(r.ids.length,0);assert.equal(r.cont,null);
  console.log('REPRODUCED: console script treats HTTP 403 as an empty playlist');
})().catch(e=>{console.error(e);process.exitCode=1});
