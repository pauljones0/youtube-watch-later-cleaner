const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const C = require('../cleaner-core.js');
function transport(fetch) {
  let timer, cleared = false, options;
  const page = { AbortController, fetch: (url, opts) => { options = opts; return fetch(url, opts); } };
  const context = vm.createContext({ WLCCore: C, window: { wrappedJSObject: page }, console, URL,
    cloneInto: x => x, setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { cleared = true; } });
  const src = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  vm.runInContext(src.slice(0, src.indexOf('  const cleaner =')) + 'globalThis.transport = request;})();', context);
  return { request: context.transport, timeout: () => timer(), options: () => options, cleared: () => cleared };
}
test('timeout includes stalled body consumption and aborts the actual request', async () => {
  let finish;
  const t = transport(async () => ({ status: 200, text: () => new Promise(r => { finish = r; }) }));
  const p = t.request('/fake', {}, {}, new AbortController().signal);
  await new Promise(r => setImmediate(r));t.timeout();
  await assert.rejects(p, e => e.code === 'timeout');
  assert.equal(t.options().signal.aborted, true);assert.equal(t.cleared(), true);finish('{}');
});
test('Stop aborts both the page request and the waiting caller', async () => {
  const t = transport(() => new Promise(() => {}));const stop = new AbortController();
  const p = t.request('/fake', {}, {}, stop.signal);stop.abort();
  await assert.rejects(p, e => e.code === 'cancelled');assert.equal(t.options().signal.aborted, true);
});
test('HTTP and invalid-JSON responses cannot become successful empty data', async () => {
  const bad = transport(async () => ({ status: 403, text: async () => '{"error":{}}' }));
  await assert.rejects(bad.request('/fake', {}, {}, new AbortController().signal), e => e.status === 403);
  const malformed = transport(async () => ({ status: 200, text: async () => '<html>login</html>' }));
  await assert.rejects(malformed.request('/fake', {}, {}, new AbortController().signal), e => e.code === 'json');
});
test('successful requests clear their timeout', async () => {
  const t = transport(async () => ({ status: 200, text: async () => '{"ok":true}' }));
  assert.equal((await t.request('/fake', {}, {}, new AbortController().signal)).ok, true);assert.equal(t.cleared(), true);
});
