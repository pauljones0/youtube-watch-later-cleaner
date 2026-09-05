const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const C = require('../cleaner-core.js');
async function popup({ reject = false, threshold = 80, statusReply } = {}) {
  const elements = {}, sent = []; let ready, receive, refresh; let statusReads = 0;
  let state = { documentId: 'doc1', revision: 0, phase: 'idle', running: false, count: 0, observed: 0, remaining: null };
  function element(id) { return elements[id] ||= { hidden: false, disabled: false, textContent: '', value: '', style: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, addEventListener(event, fn) { this.listeners[event] = fn; } }; }
  const context = vm.createContext({ WLCCore: C, console, navigator: {}, clearTimeout() {}, setTimeout() { return 1; },
    window: { addEventListener() {} }, document: { getElementById: element, addEventListener(event, fn) { ready = fn; } },
    browser: { storage: { local: { get: async () => ({ cleanerSettings: { sliderThreshold: threshold, advancedOpen: true } }), set: async () => {} } },
      runtime: { getManifest: () => ({ version: '3.0' }), onMessage: { addListener(fn) { receive = fn; } } },
      tabs: { onUpdated: { addListener(fn) { refresh = () => fn(1, { status: 'complete' }); } }, onActivated: { addListener() {} },
        query: async () => [{ id: 1, url: 'https://www.youtube.com/playlist?list=WL' }],
        sendMessage: async (id, message) => {
          sent.push(message);
          if (message.command === 'status') return statusReply ? statusReply({ ...state }, ++statusReads) : { ...state };
          if (message.command === 'start') {
            if (reject) return { accepted: false, message: 'Please sign in.', state };
            state = { ...state, revision: state.revision + 1, runId: 1, running: true, phase: 'scanning', message: 'Scanning…', threshold: message.threshold };
            receive({ type: 'state', state }, { tab: { id } }); return { accepted: true, state };
          }
          if (message.command === 'stop') {
            state = { ...state, revision: state.revision + 1, running: false, phase: 'stopped', message: 'Stopped.', count: 7 };
            receive({ type: 'state', state }, { tab: { id } }); return { accepted: true, state };
          }
          return { ok: true };
        } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../popup.js'), 'utf8'), context);
  await ready();return { elements, sent, receive, refresh };
}
test('closing Advanced preserves the selected deletion filter', async () => {
  const { elements: e, sent } = await popup();
  e.advancedToggle.listeners.click(); await e.actionButton.listeners.click();
  assert.equal(sent.find(m => m.command === 'start').threshold, 80);
});
test('Stop acknowledges settled state and re-enables Start with final count', async () => {
  const { elements: e } = await popup();await e.actionButton.listeners.click();await e.actionButton.listeners.click();
  assert.equal(e.actionButton.disabled, false);assert.equal(e.actionButton.textContent, 'Start Cleaning');assert.equal(e.count.textContent, '7');
});
test('foreign-tab and older-run messages cannot overwrite the active run', async () => {
  const { elements: e, receive } = await popup();await e.actionButton.listeners.click();
  receive({ type: 'state', state: { runId: 99, phase: 'done', count: 999, observed: 0 } }, { tab: { id: 99 } });
  receive({ type: 'state', state: { runId: 0, phase: 'done', count: 888, observed: 0 } }, { tab: { id: 1 } });
  assert.equal(e.actionButton.textContent, 'Stop');assert.equal(e.count.textContent, '0');
});
test('an unknown playlist count keeps Start available instead of claiming empty', async () => {
  const { elements: e } = await popup();assert.equal(e.actionButton.disabled, false);assert.equal(e.actionButton.textContent, 'Start Cleaning');
  assert.match(e.status.textContent, /Ready/);
});
test('a rejected Start keeps the rejection visible and never enters Running', async () => {
  const { elements: e } = await popup({ reject: true });await e.actionButton.listeners.click();
  assert.equal(e.status.textContent, 'Please sign in.');assert.equal(e.actionButton.textContent, 'Start Cleaning');assert.equal(e.actionButton.disabled, false);
});

test('a delayed post-command status cannot overwrite a newer terminal event', async () => {
  let release;
  const p = await popup({ statusReply: (snapshot, n) => n === 2 ? new Promise(r => release = () => r(snapshot)) : snapshot });
  const click = p.elements.actionButton.listeners.click();
  await new Promise(r => setImmediate(r));
  p.receive({ type: 'state', state: { documentId: 'doc1', revision: 5, runId: 1, phase: 'stopped', running: false, count: 3, observed: 0, message: 'Stopped.' } }, { tab: { id: 1 } });
  release(); await click;
  assert.equal(p.elements.actionButton.textContent, 'Start Cleaning');
  assert.equal(p.elements.count.textContent, '3');
});
test('new documents reset run ordering and delayed old-document events trigger a fresh status read', async () => {
  let doc = 'doc1';
  const p = await popup({ statusReply: snapshot => ({ ...snapshot, documentId: doc, revision: 0, runId: undefined, running: false, phase: 'idle' }) });
  await p.elements.actionButton.listeners.click();
  doc = 'doc2'; p.refresh(); await new Promise(r => setImmediate(r));
  assert.equal(p.elements.actionButton.textContent, 'Start Cleaning');
  p.receive({ type: 'state', state: { documentId: 'doc1', revision: 99, runId: 99, running: true, phase: 'removing' } }, { tab: { id: 1 } });
  await new Promise(r => setImmediate(r));
  assert.equal(p.elements.actionButton.textContent, 'Start Cleaning');
});
