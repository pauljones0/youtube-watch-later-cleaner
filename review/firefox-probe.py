"""Firefox content-script boundary probe against a local synthetic page only.
Start geckodriver --port 4445, then run python3 review/firefox-probe.py.
Uses Python requests, a temporary extension, and an isolated headless profile.
"""
import base64
import io
import json
import pathlib
import threading
import time
import zipfile
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = b'''<html><body><ytd-playlist-video-list-renderer></ytd-playlist-video-list-renderer>
<script>
const list=document.querySelector('ytd-playlist-video-list-renderer');
list.data={contents:[{playlistVideoRenderer:{setVideoId:'a',videoId:'video-a'}}]};
list.polymerController={data:list.data};
window.ytcfg={data_:{INNERTUBE_API_KEY:'fake',INNERTUBE_CONTEXT:{client:{}}}};
window.fetch=async()=>new Response(JSON.stringify({status:'STATUS_SUCCEEDED'}),{status:200});
</script></body></html>'''

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
endpoint = 'http://127.0.0.1:4445'
session = requests.post(endpoint+'/session', json={'capabilities': {'alwaysMatch': {
    'browserName':'firefox', 'moz:firefoxOptions':{'args':['-headless']}}}}).json()['value']['sessionId']
base = endpoint+'/session/'+session
def call(route, value):
    response = requests.post(base+route, json=value)
    response.raise_for_status()
    return response.json()['value']

try:
    probe = r'''
    (async()=>{
      const list=document.querySelector('ytd-playlist-video-list-renderer');
      const r={
        visibleData:typeof list.data,
        unwrappedData:typeof list.wrappedJSObject.data,
        actualContents:getPlaylistContentsArray(),
        hydration:removeVideosFromHydratedList([{setVideoId:'a',videoId:'video-a'}]),
        config:!!getYtConfig(),
      };
      try { r.fetch=await pageFetch(location.origin+'/fake',{},'{}'); }
      catch(e){r.fetchError=String(e)}
      document.documentElement.setAttribute('data-review',JSON.stringify(r));
    })();
    '''
    source = subprocess.check_output(['git','show','be4a77f:content.js'],cwd=ROOT,text=True)
    end = source.rfind('})();')
    source = source[:end]+probe+source[end:]
    manifest = {'manifest_version':2, 'name':'WLC isolated review probe', 'version':'1.0',
        'browser_specific_settings':{'gecko':{'id':'wlc-review-probe@example.invalid'}},
        'content_scripts':[{'matches':['http://127.0.0.1/*'], 'js':['content.js']}]}
    archive = io.BytesIO()
    with zipfile.ZipFile(archive,'w') as z:
        z.writestr('manifest.json',json.dumps(manifest))
        z.writestr('content.js',source)
    call('/moz/addon/install', {'addon':base64.b64encode(archive.getvalue()).decode(), 'temporary':True})
    call('/url', {'url':f'http://127.0.0.1:{http.server_port}/'})
    result = None
    for _ in range(100):
        result = call('/execute/sync', {'script':"return document.documentElement.getAttribute('data-review')",'args':[]})
        if result:
            break
        time.sleep(.2)
    result = json.loads(result)
    print(json.dumps(result,indent=2))
    assert result['visibleData'] == 'undefined'
    assert result['unwrappedData'] == 'object'
    assert result['actualContents'] is None
    assert result['hydration']['mode'] == 'unavailable'
    assert result['config'] is True
    assert result['fetch']['status'] == 'STATUS_SUCCEEDED'
    print('Firefox Xray hydration failure reproduced; page-context fetch control passed.')
finally:
    requests.delete(base)
    http.shutdown()
