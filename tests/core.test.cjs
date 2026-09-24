const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../cleaner-core.js');
const config = () => ({ INNERTUBE_API_KEY: 'test', INNERTUBE_CONTEXT: { client: {} }, SESSION_INDEX: 2, DELEGATED_SESSION_ID: 'brand' });
function response(videos, token = null, continuation = false) {
  const contents = videos.map(v => ({ playlistVideoRenderer: { setVideoId: v.id, videoId: v.id,
    thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: v.percent || 0 } }] } }));
  if (token) contents.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  return continuation ? { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: contents } }] }
    : { contents: { playlistVideoListRenderer: { contents } } };
}
function setup(videos = []) {
  const events = [], calls = [], backend = videos.slice(); let url = 'https://www.youtube.com/playlist?extra=1&list=WL';
  const cfg = config();
  const adapter = { config: () => cfg, cookies: () => 'SAPISID=test', url: () => url,
    onState: s => events.push(s), request: async (endpoint, headers, body, signal) => {
      C.check(signal); calls.push({ endpoint, headers, body });
      if (endpoint.includes('edit_playlist')) {
        for (const action of body.actions) { const i = backend.findIndex(v => v.id === action.setVideoId); if (i >= 0) backend.splice(i, 1); }
        return { status: 'STATUS_SUCCEEDED' };
      }
      return response(backend);
    } };
  const cleaner = new C.Cleaner(adapter);
  return { cleaner, adapter, cfg, backend, calls, events, navigate: value => { url = value; } };
}
test('URL validation handles query order and rejects unrelated hosts/list IDs', () => {
  assert.equal(C.isWatchLater('https://www.youtube.com/playlist?x=1&list=WL'), true);
  for (const u of ['https://www.youtube.com/playlist?list=WLother', 'https://evilyoutube.com/playlist?list=WL', 'https://www.youtube.com/watch?v=a&list=WL', 'not a url']) assert.equal(C.isWatchLater(u), false);
});
test('account and brand headers reflect the page; cookies are hashed, not forwarded', async () => {
  const headers = await C.authHeaders(config(), 'SAPISID=secret; __Secure-1PAPISID=first; __Secure-3PAPISID=third');
  assert.equal(headers['X-Goog-AuthUser'], '2'); assert.equal(headers['X-Goog-PageId'], 'brand');
  assert.match(headers.Authorization, /SAPISIDHASH \d+_[a-f0-9]{40}/);
  assert.match(headers.Authorization, /SAPISID1PHASH/); assert.match(headers.Authorization, /SAPISID3PHASH/);
  assert.equal(headers.Authorization.includes('secret'), false);
});
test('parser rejects API errors, missing schema, missing IDs and malformed continuations', () => {
  for (const rb of [null, { error: { message: 'Forbidden' } }, {}, { contents: { playlistVideoListRenderer: { contents: [{ playlistVideoRenderer: {} }] } } },
    { contents: { playlistVideoListRenderer: { contents: [{ continuationItemRenderer: {} }] } } }]) assert.throws(() => C.parsePage(rb));
  assert.deepEqual(C.parsePage(response([])), { videos: [], continuation: null });
});
test('brand/session identity can come from DATASYNC_ID and participates in the hash', async () => {
  const cfg = { ...config(), DELEGATED_SESSION_ID: undefined, DATASYNC_ID: 'channel||user' };
  const h = await C.authHeaders(cfg, 'SAPISID=secret');
  assert.equal(h['X-Goog-PageId'], 'channel');
  const [, timestamp, digest] = h.Authorization.match(/^SAPISIDHASH (\d+)_([a-f0-9]+)_u$/);
  assert.equal(digest, require('node:crypto').createHash('sha1').update(`user ${timestamp} secret https://www.youtube.com`).digest('hex'));
});
test('parser accepts both continuation response containers', () => {
  const rb = response([{ id: 'a', percent: 82 }], null, true);
  rb.onResponseReceivedEndpoints = rb.onResponseReceivedActions; delete rb.onResponseReceivedActions;
  assert.equal(C.parsePage(rb, true).videos[0].watchedPercent, 82);
});
test('filtered run deletes only qualifying IDs and verifies exact remaining count', async () => {
  const { cleaner, backend, calls } = setup([{ id: 'watched', percent: 85 }, { id: 'keep', percent: 20 }]);
  assert.equal(cleaner.start(80).accepted, true); await cleaner.task;
  assert.equal(cleaner.state.phase, 'done'); assert.equal(cleaner.state.count, 1); assert.equal(cleaner.state.remaining, 1);
  assert.deepEqual(backend, [{ id: 'keep', percent: 20 }]);
  assert.equal(calls.every(c => c.headers['X-Goog-AuthUser'] === '2'), true);
});
test('fractional watch progress is not rounded up across a deletion threshold', async () => {
  const { cleaner, backend } = setup([{ id: 'almost', percent: 99.9 }, { id: 'complete', percent: '100%' }]);
  cleaner.start(100);await cleaner.task;
  assert.equal(cleaner.state.phase, 'done');assert.deepEqual(backend, [{ id: 'almost', percent: 99.9 }]);
});
test('initial failed scan with no fallback cannot be reported done', async () => {
  const { cleaner, adapter } = setup(); adapter.request = async () => { throw new Error('HTTP403'); };
  cleaner.start(); await cleaner.task; assert.equal(cleaner.state.phase, 'error');assert.equal(cleaner.state.count, 0);
});
test('later-page failure does not delete a partial snapshot or report completion', async () => {
  const { cleaner, adapter } = setup(); let edits = 0;
  adapter.request = async (url, h, b) => {
    if (url.includes('edit_playlist')) edits++;
    if (b.continuation) throw new Error('timeout');
    return response([{ id: 'a', percent: 90 }], 'next');
  };
  cleaner.start(80); await cleaner.task; assert.equal(cleaner.state.phase, 'error'); assert.equal(edits, 0);
});
test('failed verification preserves an uncertain result and never fabricates a deletion', async () => {
  const { cleaner, adapter } = setup(); let scan = 0;
  adapter.request = async (url) => {
    if (url.includes('edit_playlist')) throw new Error('timeout');
    if (scan++) throw new Error('verification timeout');
    return response([{ id: 'a' }]);
  };
  cleaner.start(0, { confirmDeleteAll: true }); await cleaner.task; assert.equal(cleaner.state.phase, 'error'); assert.equal(cleaner.state.count, 0);
  assert.equal(cleaner.state.uncertain, true);
});
test('ambiguous edit verifies absence and retries only still-present IDs', async () => {
  const { cleaner, adapter, backend } = setup([{ id: 'a' }, { id: 'b' }]); let edits = 0; const batches = [];
  const original = adapter.request;
  adapter.request = async (url, h, b, s) => {
    if (url.includes('edit_playlist')) {
      batches.push(b.actions.map(a => a.setVideoId));
      if (!edits++) { backend.splice(0, 1); throw new Error('response lost'); }
    }
    return original(url, h, b, s);
  };
  cleaner.start(0, { confirmDeleteAll: true });await cleaner.task;
  assert.deepEqual(batches, [['a', 'b'], ['b']]); assert.equal(cleaner.state.count, 2);assert.equal(cleaner.state.phase, 'done');
});
test('Stop aborts pending work, prevents next chunk and serializes restart', async () => {
  const { cleaner, adapter } = setup(Array.from({ length: 101 }, (_, i) => ({ id: String(i) }))); const original = adapter.request;
  let entered, edits = 0; const pending = new Promise(r => entered = r);
  adapter.request = async (url, h, b, signal) => {
    if (!url.includes('edit_playlist')) return original(url, h, b, signal);
    edits++; entered();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new C.Failure('Stopped.', 'cancelled')), { once: true }));
  };
  cleaner.start(0, { confirmDeleteAll: true }); await pending;
  const stop = cleaner.stop(); assert.equal(cleaner.start(100).accepted, false); await stop;
  assert.equal(edits, 1); assert.equal(cleaner.state.running, false); assert.equal(cleaner.state.phase, 'stopped');
  assert.equal(cleaner.state.uncertain, true); assert.equal(cleaner.task, null);
  adapter.request = original;
  assert.equal(cleaner.start(100).accepted, true); await cleaner.task; assert.equal(cleaner.state.count, 0);
});
test('navigation and account changes prevent deletion', async () => {
  for (const kind of ['url', 'account', 'config-disappeared']) {
    const { cleaner, adapter, cfg, navigate } = setup([{ id: 'a' }]);let edits = 0;const original = adapter.request;
    adapter.request = async (url, h, b, s) => {
      if (url.includes('edit_playlist')) edits++;
      const rb = await original(url, h, b, s);
      if (kind === 'url') navigate('https://www.youtube.com/playlist?list=OTHER');
      else if (kind === 'account') cfg.SESSION_INDEX = 7;
      else adapter.config = () => null;
      return rb;
    };
    cleaner.start(0, { confirmDeleteAll: true });await cleaner.task;assert.equal(edits, 0);assert.equal(cleaner.state.phase, 'stopped');
  }
});
test('repeated continuation token is an error, not an incomplete successful scan', async () => {
  const { cleaner, adapter } = setup();adapter.request = async (u, h, b) => response([{ id: 'a' }], 'same', !!b.continuation);
  cleaner.start();await cleaner.task;assert.equal(cleaner.state.phase, 'error');assert.equal(cleaner.state.count, 0);
});
test('UI-only observations with failed verification are partial, not confirmed counts', async () => {
  const { cleaner, adapter } = setup();adapter.request = async () => { throw new Error('forbidden'); };
  adapter.fallback = async control => { control.onRemoved();return { failed: 0 }; };
  cleaner.start();await cleaner.task;assert.equal(cleaner.state.count, 0);assert.equal(cleaner.state.observed, 1);assert.equal(cleaner.state.phase, 'error');
});
test('final verification catches a successful edit response that did not remove targets', async () => {
  const { cleaner, adapter } = setup([{ id: 'a' }]);const original = adapter.request;
  adapter.request = async (u, h, b, s) => u.includes('edit_playlist') ? { status: 'STATUS_SUCCEEDED' } : original(u,h,b,s);
  cleaner.start(0, { confirmDeleteAll: true });await cleaner.task;assert.equal(cleaner.state.phase, 'error');assert.match(cleaner.state.message, /matching videos remain/);
});
test('retry regenerates authentication after cookie rotation', async () => {
  const { cleaner, adapter } = setup([{ id: 'a' }]);const original = adapter.request;let cookie = 'first', edits = 0;const auth = [];
  adapter.cookies = () => `SAPISID=${cookie}`;
  adapter.request = async (u, h, b, s) => {
    if (u.includes('edit_playlist')) {
      auth.push(h.Authorization);
      if (!edits++) { cookie = 'rotated'; return { status: 'STATUS_FAILED' }; }
    }
    return original(u,h,b,s);
  };
  cleaner.start(0, { confirmDeleteAll: true });await cleaner.task;assert.equal(cleaner.state.phase, 'done');assert.notEqual(auth[0],auth[1]);
});
test('a complete final scan resolves earlier UI failures when no targets remain', async () => {
  const { cleaner, adapter, backend } = setup([{ id: 'a' }]);let first = true;const original = adapter.request;
  adapter.request = async (...args) => { if (first) { first = false;throw new Error('transient browse failure'); }return original(...args); };
  adapter.fallback = async () => { backend.length = 0;return { failed: 1, incomplete: true }; };
  cleaner.start();await cleaner.task;assert.equal(cleaner.state.phase, 'done');assert.equal(cleaner.state.remaining, 0);
});
test('container continuations are followed and ambiguous or malformed tokens fail closed', () => {
  const rb = { continuationContents: { playlistVideoListContinuation: { contents: [], continuations: [{ nextContinuationData: { continuation: 'third' } }] } } };
  assert.equal(C.parsePage(rb, true).continuation, 'third');
  rb.continuationContents.playlistVideoListContinuation.continuations.push({ reloadContinuationData: { continuation: 'other' } });
  assert.throws(() => C.parsePage(rb, true), /continuation/);
  const initial = response([], 'first');
  initial.contents.playlistVideoListRenderer.contents.push({ continuationItemRenderer: {} });
  assert.throws(() => C.parsePage(initial), /continuation/);
  initial.contents.playlistVideoListRenderer.contents.pop();
  initial.contents.playlistVideoListRenderer.continuations = [{ nextContinuationData: { continuation: 'other' } }];
  assert.throws(() => C.parsePage(initial), /Conflicting/);
});
test('throwing state and logging observers cannot strand the task or prevent Stop', async () => {
  const { cleaner, adapter } = setup();
  adapter.onState = () => { throw Error('UI failed'); };
  adapter.log = () => { throw Error('logger failed'); };
  adapter.request = async () => { throw Error('offline'); };
  assert.equal(cleaner.start().accepted, true); await cleaner.task;
  assert.equal(cleaner.task, null); assert.equal(cleaner.state.running, false);
  assert.equal(cleaner.state.phase, 'error');
  assert.equal(cleaner.start().accepted, true); await cleaner.stop();
  assert.equal(cleaner.task, null);
});
test('verification still detects an undeleted target when watch progress drops', async () => {
  const { cleaner, adapter, backend } = setup([{ id: 'target', percent: 100 }]);
  const original = adapter.request;
  adapter.request = async (u, ...args) => {
    if (u.includes('edit_playlist')) { backend[0].percent = 0; return { status: 'STATUS_SUCCEEDED' }; }
    return original(u, ...args);
  };
  cleaner.start(80); await cleaner.task;
  assert.equal(cleaner.state.phase, 'error'); assert.equal(backend.length, 1);
});
test('the default threshold keeps unwatched videos instead of clearing everything', async () => {
  const { cleaner, backend } = setup([{ id: 'unwatched', percent: 0 }, { id: 'partial', percent: 50 }, { id: 'watched', percent: 95 }]);
  assert.equal(C.DEFAULT_THRESHOLD > 0, true);
  assert.equal(cleaner.start().accepted, true); await cleaner.task;
  assert.equal(cleaner.state.phase, 'done');
  assert.deepEqual(backend.map(v => v.id).sort(), ['partial', 'unwatched']);
});
test('an unconfirmed zero threshold is rejected without deleting anything', async () => {
  const { cleaner, backend, calls } = setup([{ id: 'a' }]);
  const result = cleaner.start(0);
  assert.equal(result.accepted, false);
  assert.match(result.message, /confirm/i);
  assert.equal(cleaner.task, null);
  assert.equal(calls.filter(c => c.endpoint.includes('edit_playlist')).length, 0);
  assert.equal(backend.length, 1);
});
test('a confirmed zero threshold still clears the whole list', async () => {
  const { cleaner, backend } = setup([{ id: 'a' }, { id: 'b', percent: 0 }]);
  assert.equal(cleaner.start(0, { confirmDeleteAll: true }).accepted, true); await cleaner.task;
  assert.equal(cleaner.state.phase, 'done'); assert.equal(cleaner.state.count, 2);
  assert.deepEqual(backend, []);
});
test('fallback excludes IDs already reconciled as removed from a partially applied batch', async () => {
  const { cleaner, adapter, backend } = setup([{ id: 'a', percent: 100 }, { id: 'b', percent: 100 }]);
  const original = adapter.request;
  adapter.request = async (u, ...args) => {
    if (u.includes('edit_playlist')) { if (backend[0]?.id === 'a') backend.shift(); return { status: 'STATUS_FAILED' }; }
    return original(u, ...args);
  };
  adapter.fallback = async control => { assert.deepEqual([...control.selectedIds], ['b']); backend.length = 0; return { failed: 0 }; };
  cleaner.start(80); await cleaner.task;
  assert.equal(cleaner.state.phase, 'done'); assert.equal(cleaner.state.count, 1);
});
