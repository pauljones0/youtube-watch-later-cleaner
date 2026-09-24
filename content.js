/* Firefox/console adapter. YouTube owns its DOM and internal list model. */
(() => {
  'use strict';
  if (globalThis.WatchLaterCleaner) return;
  const C = globalThis.WLCCore;
  const extension = typeof browser !== 'undefined' ? browser : null;
  const page = window.wrappedJSObject || window;
  const VERSION = extension?.runtime.getManifest().version || '3.0-console';
  const LAST_RUN_KEY = 'cleanerLastRun';
  let overlay = null, popupVisible = false, saving = Promise.resolve();
  const logs = [];
  function log(...args) {
    const message = args.map(v => String(v ?? '')).join(' ');
    logs.push({ time: Date.now(), message }); if (logs.length > 300) logs.shift();
    console.log('[WLC]', message);
  }
  function config() {
    try { return JSON.parse(JSON.stringify(page.ytcfg?.data_ || null)); }
    catch (_) { return null; }
  }
  async function request(path, headers, body, signal) {
    C.check(signal);
    const controller = new page.AbortController();
    const raw = { method: 'POST', headers, body: JSON.stringify(body), credentials: 'include' };
    const options = window.wrappedJSObject ? cloneInto(raw, page) : raw;
    options.signal = controller.signal;
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(new C.Failure('Stopped.', 'cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new C.Failure('YouTube request timed out.', 'timeout')); }, 15000);
    });
    try {
      const operation = (async () => {
        const response = await page.fetch(new URL(path, 'https://www.youtube.com').href, options);
        const text = String(await response.text());
        if (response.status < 200 || response.status >= 300) throw new C.Failure(`YouTube API returned HTTP ${response.status}.`, 'http', response.status);
        try { return JSON.parse(text); }
        catch (_) { throw new C.Failure('YouTube returned invalid JSON.', 'json'); }
      })();
      return await Promise.race([operation, interrupted]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  function makeOverlay() {
    if (overlay) return;
    const host = document.createElement('div');
    host.id = 'wlc-overlay-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host { all:initial; position:fixed; bottom:20px; right:20px; z-index:2147483647; }
      section { max-width:340px; background:#181818; color:#fafafa; border:1px solid #555;
        border-radius:12px; padding:16px; font:14px/1.5 system-ui,sans-serif; box-shadow:0 4px 20px #0006; }
      p { margin:0 0 10px } button { cursor:pointer; padding:6px 12px; margin-right:8px; }
    </style><section aria-live="polite"><p></p><button id="stop">Stop</button><button id="refresh">Refresh playlist</button><button id="close">Dismiss</button></section>`;
    overlay = { host, text: shadow.querySelector('p'), stop: shadow.querySelector('#stop'), refresh: shadow.querySelector('#refresh') };
    overlay.stop.addEventListener('click', () => cleaner.stop());
    overlay.refresh.addEventListener('click', () => { if (!cleaner.state.running && C.isWatchLater(location.href)) location.reload(); });
    shadow.querySelector('#close').addEventListener('click', () => { if (!cleaner.state.running) { host.remove(); overlay = null; } });
    (document.body || document.documentElement).appendChild(host);
  }
  function render(state) {
    if (state.phase === 'idle') return;
    makeOverlay();
    overlay.host.style.display = popupVisible ? 'none' : 'block';
    overlay.text.textContent = `${state.message}${state.running ? ` Confirmed API removals: ${state.count}; UI rows removed: ${state.observed}.` : ''}`;
    overlay.stop.hidden = !state.running; overlay.stop.disabled = state.phase === 'stopping';
    overlay.refresh.hidden = state.running;
  }
  function saveRun(state) {
    if (!extension || state.running || !state.runId) return;
    const snapshot = { version: VERSION, state: { ...state }, logs: logs.slice(), savedAt: Date.now() };
    saving = saving.catch(() => {}).then(() => extension.storage.local.set({ [LAST_RUN_KEY]: snapshot }));
    saving.catch(error => log('Could not save diagnostics:', error.message));
  }
  function rowInfo(row) {
    // Unwrap only to read the row's action identity; never write page-model objects.
    let data;
    try { const raw = row.wrappedJSObject || row; data = JSON.parse(JSON.stringify(raw.data || raw.__data?.data || null)); } catch (_) {}
    const href = row.querySelector('a#video-title[href], a#thumbnail[href]')?.href;
    let videoId = data?.videoId || null;
    try { videoId ||= new URL(href).searchParams.get('v'); } catch (_) {}
    const progress = row.querySelector('ytd-thumbnail-overlay-resume-playback-renderer #progress');
    const match = (progress?.style.width || '').match(/([\d.]+)%/);
    const key = data?.setVideoId || videoId || row;
    return { key, setVideoId: data?.setVideoId || null, videoId, watchedPercent: C.watchedPercent(match?.[1] || 0) };
  }
  function menuData(node) {
    try { const raw = node.wrappedJSObject || node; return JSON.parse(JSON.stringify(raw.data || raw.__data?.data || null)); } catch (_) { return null; }
  }
  function removalMatches(data, info) {
    if (!data || typeof data !== 'object') return false;
    const endpoint = data.serviceEndpoint?.playlistEditEndpoint || data.navigationEndpoint?.playlistEditEndpoint || data.playlistEditEndpoint;
    return endpoint?.playlistId === 'WL' && Array.isArray(endpoint.actions) && endpoint.actions.length === 1 && endpoint.actions.every(a => a.action === 'ACTION_REMOVE_VIDEO'
      && ((info.setVideoId && a.setVideoId === info.setVideoId) || (!a.setVideoId && info.videoId && a.removedVideoId === info.videoId)));
  }
  function visible(node) { return !!(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'); }
  async function until(test, control, ms = 3000) {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      control.guard(); const value = test(); if (value) return value;
      await C.delay(100, control.signal);
    }
    return null;
  }
  async function removeRow(row, info, control) {
    control.guard();
    const button = row.querySelector('#menu button'); if (!button) return false;
    // Close old menus before opening this row's menu.
    document.body.click();
    await C.delay(100, control.signal); control.guard();
    if (!row.isConnected) return false;
    button.click();
    const option = await until(() => {
      for (const menu of document.querySelectorAll('ytd-menu-popup-renderer')) {
        if (!visible(menu)) continue;
        for (const item of menu.querySelectorAll('ytd-menu-service-item-renderer, [role="menuitem"]')) {
          if (visible(item) && removalMatches(menuData(item), info)) return item;
        }
      }
      return null;
    }, control);
    control.guard();
    if (!option || !row.isConnected) { document.body.click(); return false; }
    control.onMutation();
    option.click();
    const gone = await until(() => !row.isConnected, control, 5000);
    if (!gone) { document.body.click(); throw new C.Failure('Page removal outcome is unknown. Refresh to verify.', 'uncertain'); }
    return !!gone;
  }
  async function fallback(control) {
    let failed = 0, idle = 0; const processed = new Set();
    while (idle < 5) {
      control.guard();
      const rows = [...document.querySelectorAll('ytd-playlist-video-renderer')];
      const next = rows.map(row => ({ row, info: rowInfo(row) })).find(v => !processed.has(v.info.key));
      if (next) {
        idle = 0; processed.add(next.info.key);
        if (control.selectedIds ? !control.selectedIds.has(next.info.setVideoId) : next.info.watchedPercent < control.threshold) continue;
        next.row.scrollIntoView({ block: 'center' });
        await C.delay(150, control.signal); control.guard();
        if (await removeRow(next.row, next.info, control)) control.onRemoved(); else failed++;
        await C.delay(400, control.signal); continue;
      }
      const before = rows.length;
      rows.at(-1)?.scrollIntoView({ block: 'end' });
      window.scrollBy(0, Math.max(600, window.innerHeight));
      await C.delay(1500, control.signal); control.guard();
      if (document.querySelectorAll('ytd-playlist-video-renderer').length > before) idle = 0; else idle++;
    }
    // The core verifies via a full API scan; DOM exhaustion alone never proves completion.
    return { failed, incomplete: false };
  }
  const cleaner = new C.Cleaner({ url: () => location.href, config, cookies: () => document.cookie, request, fallback, log,
    onState: state => { render(state); saveRun(state); extension?.runtime.sendMessage({ type: 'state', state }).catch(() => {}); } });
  globalThis.WatchLaterCleaner = cleaner;
  let previewController = null;
  async function estimate(threshold) {
    if (cleaner.state.running) throw new C.Failure('Cleaning is running.', 'busy');
    previewController?.abort();
    const preview = new C.Cleaner({ url: () => location.href, config, cookies: () => document.cookie, request });
    const run = { controller: new AbortController(), identity: null };
    previewController = run.controller; preview.run = run;
    await preview.ready(run);
    const videos = await preview.scan(run);
    return { total: videos.length, matching: videos.filter(v => v.watchedPercent >= C.percent(threshold)).length };
  }
  async function diagnostics() {
    await saving.catch(() => {});
    if (cleaner.state.runId) return { version: VERSION, state: cleaner.state, logs: logs.slice() };
    return extension ? (await extension.storage.local.get(LAST_RUN_KEY))[LAST_RUN_KEY] || null : null;
  }
  if (extension) {
    extension.runtime.onMessage.addListener(message => {
      switch (message.command) {
        case 'status': return Promise.resolve({ ...cleaner.state });
        case 'start': previewController?.abort(); return Promise.resolve(cleaner.start(message.threshold, { confirmDeleteAll: message.confirmDeleteAll }));
        case 'estimate': return estimate(message.threshold);
        case 'stop': return cleaner.stop();
        case 'getLogs': return diagnostics();
        case 'setPopupVisible':
          popupVisible = !!message.visible;
          if (!popupVisible) previewController?.abort();
          render(cleaner.state); return Promise.resolve({ ok: true });
        default: return undefined;
      }
    });
  }
  function navigation() {
    if (!cleaner.state.running) return;
    try { cleaner.guard(cleaner.run); } catch (_) { cleaner.stop(); }
  }
  document.addEventListener('yt-navigate-start', () => { previewController?.abort(); if (cleaner.state.running) cleaner.stop(); });
  document.addEventListener('yt-navigate-finish', navigation);
  window.addEventListener('popstate', navigation);
  window.addEventListener('pagehide', () => { if (cleaner.state.running) cleaner.stop(); });
  // Also catches account changes that do not emit a YouTube navigation event.
  setInterval(navigation, 500);
  log(`Loaded v${VERSION}`);
})();
