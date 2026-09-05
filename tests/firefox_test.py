"""Real Firefox extension integration tests, using only a local synthetic YouTube page.
Start geckodriver --port 4445; then python3 tests/firefox_test.py (requires requests).
Only the test extension's hostname allowlist/match is extended to localhost.
All YouTube API calls are intercepted by the synthetic page; no real account is used.
"""
import io
import json
import pathlib
import os
import threading
import tempfile
import time
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = r'''<!doctype html><html><body><main></main><script>
window.ytcfg={data_:{INNERTUBE_API_KEY:'fake',INNERTUBE_CONTEXT:{client:{}},SESSION_INDEX:2,DELEGATED_SESSION_ID:'brand'}};
document.cookie='SAPISID=fake; path=/';
window.resetFixture = mode => {
  window.fixtureMode=mode;window.requestsSeen=[];window.aborts=0;
  window.backend=[{id:'a',percent:90},{id:'b',percent:10},{id:'c',percent:100}];
  document.querySelector('main').innerHTML='';
  for(const v of backend){
    const row=document.createElement('ytd-playlist-video-renderer');
    row.style.display='block';row.data={setVideoId:v.id,videoId:v.id};
    row.innerHTML=`<a id="video-title" href="/watch?v=${v.id}">${v.id}</a><ytd-thumbnail-overlay-resume-playback-renderer><span id="progress" style="width:${mode==='failEdit'?100:v.percent}%"></span></ytd-thumbnail-overlay-resume-playback-renderer><div id="menu"><button>Menu</button></div>`;
    row.querySelector('button').onclick=()=>{
      document.querySelectorAll('ytd-menu-popup-renderer').forEach(n=>n.remove());
      const menu=document.createElement('ytd-menu-popup-renderer');menu.style.display='block';
      const item=document.createElement('ytd-menu-service-item-renderer');item.setAttribute('role','menuitem');item.textContent='Remove';item.style.display='block';
      item.data={serviceEndpoint:{playlistEditEndpoint:{playlistId:'WL',actions:[{action:'ACTION_REMOVE_VIDEO',setVideoId:v.id}]}}};
      item.onclick=()=>{window.nativeClicked=true;const finish=()=>{backend=backend.filter(x=>x.id!==v.id);row.remove();menu.remove()};if(fixtureMode==='nativeStall')setTimeout(finish,1000);else finish()};
      menu.appendChild(item);document.body.appendChild(menu);
    };
    document.querySelector('main').appendChild(row);
  }
};
window.fetch=async (url,options)=>{
  const body=JSON.parse(options.body);requestsSeen.push({url,headers:options.headers,body});
  if(options.headers['X-Goog-AuthUser']!=='2'||options.headers['X-Goog-PageId']!=='brand')return new Response('{}',{status:403});
  if(fixtureMode==='httpError'||fixtureMode==='nativeStall')return new Response('{"error":{"message":"Forbidden"}}',{status:403});
  if(url.includes('edit_playlist')){
    if(fixtureMode==='stall')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{aborts++;reject(new DOMException('Aborted','AbortError'))}));
    if(fixtureMode==='failEdit')return new Response('{"status":"STATUS_FAILED"}');
    const ids=body.actions.map(a=>a.setVideoId);backend=backend.filter(v=>!ids.includes(v.id));
    return new Response('{"status":"STATUS_SUCCEEDED"}');
  }
  const offset=Number(body.continuation||0), videos=backend.slice(offset,offset+1);
  const items=videos.map(v=>({playlistVideoRenderer:{setVideoId:v.id,videoId:v.id,thumbnailOverlays:[{thumbnailOverlayResumePlaybackRenderer:{percentDurationWatched:v.percent}}]}}));
  const continuations=offset+1<backend.length?[{nextContinuationData:{continuation:String(offset+1)}}]:[];
  const response=body.continuation?{continuationContents:{playlistVideoListContinuation:{contents:items,continuations}}}:{contents:{playlistVideoListRenderer:{contents:items,continuations}}};
  return new Response(JSON.stringify(response));
};
resetFixture('normal');
</script></body></html>'''.encode()

PROBE = r'''
document.documentElement.setAttribute('data-probe-loaded', 'yes');
(async()=>{
  const results=[];
  const assert=(value,message)=>{if(!value)throw new Error(message)};
  const engine=WatchLaterCleaner, page=window.wrappedJSObject;
  const originalState = engine.a.onState;
  engine.a.onState = state => { document.documentElement.setAttribute('data-state', JSON.stringify(state)); originalState(state); };
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  assert(document.querySelector('ytd-playlist-video-renderer').data===undefined,'Xray control');
  assert(engine.start(80).accepted,'start accepted');await engine.task;
  assert(engine.state.phase==='done','normal run: '+JSON.stringify(engine.state));
  assert(engine.state.count===2 && engine.state.remaining===1,'filtered totals');
  assert(page.backend.length===1 && page.backend[0].id==='b','kept unwatched');
  results.push('filtered API run, pagination, account headers and final verification');
  assert(document.querySelectorAll('ytd-playlist-video-renderer').length===3,'no private-model mutation');
  results.push('YouTube DOM left owned by YouTube; explicit refresh available');
  await wait(100);
  const saved=await browser.storage.local.get('cleanerLastRun');
  assert(saved.cleanerLastRun.state.phase==='done','diagnostics persisted');
  results.push('completed diagnostics persisted in extension storage');
  page.resetFixture('stall');engine.start(0);
  for(let i=0;i<100&&!JSON.parse(JSON.stringify(page.requestsSeen)).some(r=>r.url.includes('edit_playlist'));i++)await wait(20);
  const stop=engine.stop();assert(!engine.start(100).accepted,'restart blocked while stopping');await stop;
  assert(engine.state.phase==='stopped' && page.aborts===1,'abort crosses Firefox compartment');
  assert(engine.state.count===0 && engine.state.uncertain,'unknown edit remains unknown');
  results.push('Stop aborts page fetch and serializes restart');
  page.resetFixture('failEdit');engine.start(80);await engine.task;
  assert(engine.state.phase==='done','UI fallback: '+JSON.stringify(engine.state));
  assert(engine.state.observed===2 && page.backend.length===1,'endpoint-identified UI removal');
  results.push('real DOM fallback reads Xray-unwrapped row/menu identities and verifies result');
  page.resetFixture('nativeStall');page.nativeClicked=false;engine.start(80);
  for(let i=0;i<200&&!page.nativeClicked;i++)await wait(20);
  assert(page.nativeClicked,'native click dispatched');await engine.stop();
  assert(engine.state.uncertain && engine.state.phase==='stopped','native stop preserves uncertainty');
  await wait(1100);assert(page.backend.length===2,'native request finishes after Stop');
  results.push('Stop during native click preserves uncertainty despite later page mutation');
  page.resetFixture('httpError');engine.start(80);await engine.task;
  assert(engine.state.phase==='error' && engine.state.count===0,'HTTP failure not success');
  results.push('HTTP errors with UI-only outcomes reported as partial');
  document.documentElement.setAttribute('data-results',JSON.stringify({passed:results}));
})().catch(error=>document.documentElement.setAttribute('data-results',JSON.stringify({error:String(error),stack:error.stack,state:globalThis.WatchLaterCleaner?.state,core:typeof globalThis.WLCCore})));
'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(HTML)
    def log_message(self, *_):
        pass

http = HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=http.serve_forever, daemon=True).start()
endpoint = os.environ.get('WLC_WEBDRIVER_URL', 'http://127.0.0.1:4445')
firefox_options = {'args': ['-headless']}
if os.environ.get('WLC_FIREFOX_BINARY'):
    firefox_options['binary'] = os.environ['WLC_FIREFOX_BINARY']
response = requests.post(endpoint+'/session', json={'capabilities': {'alwaysMatch': {
    'browserName': 'firefox', 'moz:firefoxOptions': firefox_options}}})
if not response.ok:
    raise RuntimeError(response.text)
session = response.json()['value']['sessionId']
base = endpoint+'/session/'+session
def call(route, payload):
    r = requests.post(base+route, json=payload)
    if not r.ok:
        raise RuntimeError(f'{route}: {r.text}')
    return r.json()['value']

fixture_path = None
try:
    manifest = json.loads((ROOT/'manifest.json').read_text())
    manifest['browser_specific_settings']['gecko']['id'] = 'wlc-integration@example.invalid'
    manifest['permissions'] = ['storage']
    manifest.pop('browser_action', None)
    manifest['content_scripts'] = [{'matches':['http://127.0.0.1/*'], 'js':['cleaner-core.js','content.js','probe.js']}]
    core = (ROOT/'cleaner-core.js').read_text().replace("['www.youtube.com', 'youtube.com']", "['www.youtube.com', 'youtube.com', '127.0.0.1']")
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as z:
        z.writestr('manifest.json',json.dumps(manifest))
        z.writestr('cleaner-core.js',core)
        z.writestr('content.js',(ROOT/'content.js').read_text())
        z.writestr('icon.svg',(ROOT/'icon.svg').read_text())
        z.writestr('probe.js',PROBE)
    # Path-based installation also works with Firefox 128's older Marionette API.
    with tempfile.NamedTemporaryFile(dir=ROOT, suffix='.xpi', delete=False) as fixture:
        fixture_path = pathlib.Path(fixture.name)
        fixture.write(archive.getvalue())
        fixture.flush()
        call('/moz/addon/install',{'path':fixture.name,'temporary':True})
    call('/url',{'url':f'http://127.0.0.1:{http.server_port}/playlist?list=WL'})
    result = None
    for _ in range(240):
        result = call('/execute/sync',{'script':"return document.documentElement.getAttribute('data-results')",'args':[]})
        if result:
            break
        time.sleep(.25)
    if not result:
        debug = call('/execute/sync',{'script':"return {url:location.href,probe:document.documentElement.getAttribute('data-probe-loaded'),state:document.documentElement.getAttribute('data-state'),body:document.body.innerText.slice(0,2000),requests:window.requestsSeen?.map(r=>r.url)}",'args':[]})
        result = json.dumps({'error':'Timed out waiting for integration tests','debug':debug})
    result = json.loads(result)
    print(json.dumps(result,indent=2))
    assert 'error' not in result, result
    # A fresh document with the temporary extension removed exercises the generated
    # console entry point in the page realm, without WebExtension APIs or Xrays.
    call('/moz/addon/uninstall',{'id':'wlc-integration@example.invalid'})
    call('/url',{'url':f'http://127.0.0.1:{http.server_port}/playlist?list=WL'})
    bundle = (ROOT/'removeWatchLater.js').read_text().replace("['www.youtube.com', 'youtube.com']", "['www.youtube.com', 'youtube.com', '127.0.0.1']")
    console_result = call('/execute/async',{'script':bundle+"\nconst done=arguments[arguments.length-1]; Promise.resolve(WatchLaterCleaner.task).then(()=>done({state:WatchLaterCleaner.state, remaining:window.backend.length}));",'args':[]})
    assert console_result['state']['phase'] == 'done', console_result
    assert console_result['remaining'] == 0, console_result
    print('Generated console bundle cleared and verified the local fixture in the page realm.')
finally:
    requests.delete(base)
    if fixture_path:
        fixture_path.unlink(missing_ok=True)
    http.shutdown()
