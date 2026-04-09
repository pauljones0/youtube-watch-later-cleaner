/**
 * YouTube Watch Later Cleaner — Content Script
 * Fully API-driven with UI-click fallback.
 * Heavy logging for debugging.
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Logging ---

const PREFIX = '[WLC]';

const LOG_BUFFER_MAX = 1000;
const logBuffer = [];

function pushLog(level, args) {
  const msg = args.map(a => {
    if (a == null) return String(a);
    if (typeof a === 'object') try { return JSON.stringify(a); } catch (_) { return String(a); }
    return String(a);
  }).join(' ');
  logBuffer.push({ t: Date.now(), l: level, m: msg });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

function dbg(...args) {
  console.log(PREFIX, ...args);
  pushLog('D', args);
}

function warn(...args) {
  console.warn(PREFIX, ...args);
  pushLog('W', args);
}

function err(...args) {
  console.error(PREFIX, ...args);
  pushLog('E', args);
}

// Send status to popup
function sendLog(text, className = '') {
  dbg('sendLog:', text, className);
  browser.runtime.sendMessage({ type: 'log', text, class: className }).catch(() => {});
}

function sendCount(count) {
  dbg('sendCount:', count);
  browser.runtime.sendMessage({ type: 'count', count }).catch(() => {});
}

function sendError(text) {
  err('sendError:', text);
  browser.runtime.sendMessage({ type: 'error', text }).catch(() => {});
}

function sendComplete(count) {
  dbg('sendComplete:', count);
  browser.runtime.sendMessage({ type: 'complete', count }).catch(() => {});
}

// --- Get playlist total from DOM ---

function getPlaylistTotal() {
  const el = document.querySelector('ytd-playlist-byline-renderer yt-formatted-string.byline-item');
  if (!el) return 0;
  const m = el.textContent.trim().replace(/,/g, '').match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// --- On-page progress overlay (shadow DOM) ---

let overlayHost = null;
let overlayRefs = null;
let overlayHideTimer = null;

function createOverlay() {
  destroyOverlay();

  overlayHost = document.createElement('div');
  overlayHost.id = 'wlc-overlay-host';
  overlayHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';

  const shadow = overlayHost.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      .wlc-top-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        background: rgba(255, 255, 255, 0.06);
        z-index: 2147483647;
        pointer-events: none;
        overflow: hidden;
      }

      .wlc-top-bar-fill {
        height: 100%;
        background: #6366f1;
        width: 0%;
        border-radius: 0 1px 1px 0;
      }

      .wlc-top-bar-fill.determinate {
        transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .wlc-top-bar-fill.indeterminate {
        width: 30%;
        animation: wlc-shimmer 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }

      @keyframes wlc-shimmer {
        0%   { transform: translateX(-100%); }
        100% { transform: translateX(400%); }
      }

      .wlc-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        background: rgba(15, 15, 15, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 20px;
        padding: 10px 20px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        color: #f1f1f1;
        pointer-events: auto;
        opacity: 1;
        transform: translateY(0);
        transition: opacity 0.4s ease, transform 0.4s ease;
      }

      .wlc-toast.hidden {
        opacity: 0;
        transform: translateY(12px);
        pointer-events: none;
      }

      .wlc-toast-count {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: #6366f1;
        font-size: 15px;
      }

      .wlc-toast-label {
        color: rgba(241, 241, 241, 0.7);
      }

      .wlc-toast-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #22c55e;
        flex-shrink: 0;
        animation: wlc-dot-pulse 2s ease infinite;
      }

      .wlc-toast-dot.done {
        animation: none;
        background: #6366f1;
      }

      @keyframes wlc-dot-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }

      .wlc-pulse {
        animation: wlc-count-pulse 0.35s ease;
      }

      @keyframes wlc-count-pulse {
        0%   { transform: scale(1); }
        50%  { transform: scale(1.12); }
        100% { transform: scale(1); }
      }

      @media (prefers-reduced-motion: reduce) {
        .wlc-top-bar-fill.determinate { transition-duration: 0s; }
        .wlc-top-bar-fill.indeterminate { animation: none; width: 100%; opacity: 0.3; }
        .wlc-toast { transition-duration: 0s; }
        .wlc-toast-dot { animation: none; }
        .wlc-pulse { animation: none; }
      }
    </style>

    <div class="wlc-top-bar">
      <div class="wlc-top-bar-fill indeterminate"></div>
    </div>

    <div class="wlc-toast">
      <span class="wlc-toast-dot"></span>
      <span class="wlc-toast-count">0</span>
      <span class="wlc-toast-label">videos removed</span>
    </div>
  `;

  overlayRefs = {
    barFill: shadow.querySelector('.wlc-top-bar-fill'),
    toast: shadow.querySelector('.wlc-toast'),
    count: shadow.querySelector('.wlc-toast-count'),
    label: shadow.querySelector('.wlc-toast-label'),
    dot: shadow.querySelector('.wlc-toast-dot'),
  };

  document.body.appendChild(overlayHost);
  dbg('createOverlay: created');
}

function updateOverlayProgress(removed, total) {
  if (!overlayRefs) return;

  // Switch to determinate mode
  overlayRefs.barFill.classList.remove('indeterminate');
  overlayRefs.barFill.classList.add('determinate');

  if (total > 0) {
    const pct = Math.min(100, (removed / total) * 100);
    overlayRefs.barFill.style.width = pct + '%';
  } else {
    // No total known — show fill growing but never hitting 100%
    const pct = Math.min(90, removed * 0.5);
    overlayRefs.barFill.style.width = pct + '%';
  }

  // Update count with pulse, reset label to default
  overlayRefs.count.textContent = removed.toLocaleString();
  overlayRefs.label.textContent = 'videos removed';
  overlayRefs.count.classList.remove('wlc-pulse');
  overlayRefs.count.offsetWidth; // force reflow
  overlayRefs.count.classList.add('wlc-pulse');

  overlayRefs.count.addEventListener('animationend', () => {
    overlayRefs.count.classList.remove('wlc-pulse');
  }, { once: true });
}

function updateOverlayStatus(text) {
  if (!overlayRefs) return;
  overlayRefs.label.textContent = text;
}

function completeOverlay(removed) {
  if (!overlayRefs) return;

  overlayRefs.barFill.classList.remove('indeterminate');
  overlayRefs.barFill.classList.add('determinate');
  overlayRefs.barFill.style.width = '100%';

  overlayRefs.count.textContent = removed.toLocaleString();
  overlayRefs.label.textContent = 'videos removed — refreshing...';
  overlayRefs.dot.classList.add('done');

  dbg('completeOverlay:', removed);

  // Auto-hide after 3 seconds, then refresh the page
  overlayHideTimer = setTimeout(() => {
    if (overlayRefs) {
      overlayRefs.toast.classList.add('hidden');
      setTimeout(() => {
        destroyOverlay();
        dbg('completeOverlay: refreshing page');
        window.location.reload();
      }, 500);
    }
  }, 3000);
}

function destroyOverlay() {
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  if (overlayHost) {
    overlayHost.remove();
    overlayHost = null;
    overlayRefs = null;
    dbg('destroyOverlay: removed');
  }
}

// --- Access page JS globals ---

function cloneFromPage(obj) {
  try { return JSON.parse(JSON.stringify(obj)); }
  catch (e) { warn('cloneFromPage failed:', e.message); return undefined; }
}

function getYtConfig() {
  try {
    const ytcfg = window.wrappedJSObject?.ytcfg?.data_;
    if (!ytcfg) {
      dbg('getYtConfig: ytcfg not available');
      return null;
    }
    const apiKey = ytcfg.INNERTUBE_API_KEY;
    const context = cloneFromPage(ytcfg.INNERTUBE_CONTEXT);
    dbg('getYtConfig: apiKey=' + (apiKey ? 'present' : 'MISSING') + ', context=' + (context ? 'present' : 'MISSING'));
    return (apiKey && context) ? { apiKey, context } : null;
  } catch (e) {
    err('getYtConfig error:', e.message);
    return null;
  }
}

// --- Wait for YouTube ---

async function waitForYouTubeReady(maxWaitMs = 15000) {
  dbg('waitForYouTubeReady: starting, maxWait=' + maxWaitMs + 'ms');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!window.cleanerIsRunning) {
      dbg('waitForYouTubeReady: stopped while waiting');
      return null;
    }
    const ytcfg = getYtConfig();
    if (ytcfg) {
      dbg('waitForYouTubeReady: ready after ' + (Date.now() - start) + 'ms');
      return ytcfg;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    sendLog(`Waiting for YouTube to load... (${elapsed}s)`, 'warning');
    await sleep(500);
  }
  warn('waitForYouTubeReady: timed out after ' + maxWaitMs + 'ms');
  return null;
}

// --- Page-context fetch (uses YouTube's own fetch, same-origin with cookies) ---

async function pageFetch(url, headers, body) {
  dbg('pageFetch: calling page fetch for', url.substring(0, 60) + '...');

  const opts = cloneInto({
    method: 'POST',
    headers: headers,
    body: body,
    credentials: 'include',
  }, window.wrappedJSObject);

  // Race the page fetch against a 15s timeout
  const fetchPromise = new Promise(async (resolve, reject) => {
    try {
      const resp = await window.wrappedJSObject.fetch(url, opts);
      // Read text in page context, then pull it into content script
      const text = await resp.text();
      // text crosses the compartment boundary as a string (primitive), safe to use directly
      resolve({ status: resp.status, text: '' + text });
    } catch (e) {
      reject(new Error('' + e.message));
    }
  });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 15000)
  );

  const result = await Promise.race([fetchPromise, timeoutPromise]);
  dbg('pageFetch: HTTP', result.status);
  return JSON.parse(result.text);
}

// --- Auth ---

async function generateSapisidHash() {
  const cookies = document.cookie.split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    acc[k] = v.join('=');
    return acc;
  }, {});
  const sapisid = cookies['SAPISID'] || cookies['__Secure-3PAPISID'];
  if (!sapisid) { warn('generateSapisidHash: no SAPISID cookie found'); return null; }
  const ts = Math.floor(Date.now() / 1000);
  const buf = await crypto.subtle.digest('SHA-1',
    new TextEncoder().encode(`${ts} ${sapisid} https://www.youtube.com`));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = `SAPISIDHASH ${ts}_${hex}`;
  dbg('generateSapisidHash: generated OK');
  return hash;
}

function getApiHeaders(auth) {
  return {
    'Content-Type': 'application/json',
    'Authorization': auth,
    'X-Goog-AuthUser': '0',
    'X-Origin': 'https://www.youtube.com',
  };
}

// --- Browse API (via page-context fetch) ---

async function fetchPlaylistPage(auth, ytcfg, continuationToken) {
  dbg('fetchPlaylistPage: continuation=' + (continuationToken ? 'yes' : 'no (first page)'));

  const body = continuationToken
    ? { context: ytcfg.context, continuation: continuationToken }
    : { context: ytcfg.context, browseId: 'VLWL', params: decodeURIComponent('wgYCCAA%3D') };

  let rb;
  try {
    rb = await pageFetch(
      `https://www.youtube.com/youtubei/v1/browse?key=${ytcfg.apiKey}&prettyPrint=false`,
      getApiHeaders(auth),
      JSON.stringify(body)
    );
  } catch (e) {
    err('fetchPlaylistPage: error:', e.message);
    return { ids: [], continuation: null, error: e.message };
  }

  let items;
  if (continuationToken) {
    const appendAction = rb.onResponseReceivedActions?.find(a => a.appendContinuationItemsAction);
    items = appendAction?.appendContinuationItemsAction?.continuationItems || [];
  } else {
    const pvl = rb.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer;
    items = pvl?.contents || [];

    // Check for YouTube alerts (e.g., "playlist does not exist")
    if (items.length === 0 && rb.alerts) {
      const alertText = rb.alerts.map(a => {
        const ar = a.alertWithButtonRenderer || a.alertRenderer;
        return ar?.text?.simpleText || ar?.text?.runs?.map(r => r.text).join('') || '';
      }).filter(Boolean).join('; ');
      if (alertText) {
        warn('fetchPlaylistPage: YouTube alert:', alertText);
        return { ids: [], continuation: null, error: 'yt-alert: ' + alertText };
      }
    }
  }

  const ids = items
    .filter(i => i.playlistVideoRenderer?.setVideoId)
    .map(i => i.playlistVideoRenderer.setVideoId);

  const contItem = items.find(i => i.continuationItemRenderer);
  const cmds = contItem?.continuationItemRenderer?.continuationEndpoint?.commandExecutorCommand?.commands;
  const nextToken = cmds?.find(c => c.continuationCommand)?.continuationCommand?.token
    || contItem?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
    || null;

  dbg('fetchPlaylistPage: got', ids.length, 'setVideoIds, hasNext:', !!nextToken);
  return { ids, continuation: nextToken, error: null };
}

// --- Batch remove (via page-context fetch) ---

async function batchRemoveVideos(auth, ytcfg, setVideoIds) {
  dbg('batchRemoveVideos: removing', setVideoIds.length, 'videos');

  const body = {
    context: ytcfg.context,
    playlistId: 'WL',
    actions: setVideoIds.map(id => ({ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' })),
    params: 'CAFAAQ==',
  };

  try {
    const rb = await pageFetch(
      `https://www.youtube.com/youtubei/v1/browse/edit_playlist?key=${ytcfg.apiKey}&prettyPrint=false`,
      getApiHeaders(auth),
      JSON.stringify(body)
    );
    const ok = rb?.status === 'STATUS_SUCCEEDED';
    dbg('batchRemoveVideos: ok:', ok, 'status:', rb?.status);
    return ok;
  } catch (e) {
    err('batchRemoveVideos: error:', e.message);
    return false;
  }
}

// --- Main cleaning loop ---

async function cleanAllAPI() {
  dbg('=== cleanAllAPI START ===');
  window.cleanerState.method = 'api';

  const ytcfg = await waitForYouTubeReady();
  if (!ytcfg) {
    if (!window.cleanerIsRunning) return; // stopped during wait
    warn('cleanAllAPI: ytcfg unavailable, falling back to UI');
    sendLog('YouTube config not available — using slower UI method', 'warning');
    updateOverlayStatus('switching to slower method...');
    await cleanFallbackUI(0);
    return;
  }

  const auth = await generateSapisidHash();
  if (!auth) {
    warn('cleanAllAPI: no auth, falling back to UI');
    sendLog('Auth unavailable — using slower UI method', 'warning');
    updateOverlayStatus('switching to slower method...');
    await cleanFallbackUI(0);
    return;
  }

  let totalRemoved = 0;
  let continuation = null;
  let pageNum = 0;
  const totalEstimate = getPlaylistTotal();
  dbg('cleanAllAPI: totalEstimate from DOM:', totalEstimate);

  sendLog('Fetching playlist...', 'success');
  updateOverlayStatus('fetching playlist...');

  while (window.cleanerIsRunning) {
    pageNum++;
    dbg('--- Page', pageNum, '| totalRemoved:', totalRemoved, '| continuation:', !!continuation, '---');

    const page = await fetchPlaylistPage(auth, ytcfg, continuation);

    if (page.ids.length === 0) {
      dbg('cleanAllAPI: no IDs on page', pageNum);

      // Sanity check: if API returned nothing but DOM shows videos, the API failed
      if (totalRemoved === 0 && !continuation) {
        const domCount = getPlaylistTotal();
        if (domCount > 0) {
          warn('cleanAllAPI: API returned 0 videos but DOM shows', domCount, '— falling back to UI');
          if (page.error) {
            sendLog(`API error (${page.error}) — using slower UI method`, 'warning');
          } else {
            sendLog('API returned empty — using slower UI method', 'warning');
          }
          updateOverlayStatus('switching to slower method...');
          await cleanFallbackUI(0);
          return;
        }
        sendLog('Playlist is already empty.', 'success');
      } else {
        sendLog(`Done! Removed ${totalRemoved} videos.`, 'success');
      }
      sendComplete(totalRemoved);
      completeOverlay(totalRemoved);
      window.cleanerIsRunning = false;
      window.cleanerState.running = false;
      window.cleanerState.done = true;
      window.cleanerState.count = totalRemoved;
      dbg('=== cleanAllAPI DONE ===', totalRemoved, 'removed');
      return;
    }

    if (!window.cleanerIsRunning) {
      dbg('cleanAllAPI: stopped before batch at totalRemoved:', totalRemoved);
      return;
    }

    // Send all IDs from this page in one batch (YouTube returns ~100-102 per page)
    const batch = page.ids;
    dbg('cleanAllAPI: page', pageNum, '| batch size:', batch.length);

    sendLog(`Removing ${batch.length} videos...`, 'success');
    updateOverlayStatus(totalRemoved > 0 ? `removed — processing next batch...` : `processing ${batch.length} videos...`);
    const ok = await batchRemoveVideos(auth, ytcfg, batch);

    if (ok) {
      totalRemoved += batch.length;
      window.cleanerState.count = totalRemoved;
      dbg('cleanAllAPI: batch SUCCESS, totalRemoved now:', totalRemoved);
      sendCount(totalRemoved);
      sendLog(`${totalRemoved} removed`, 'success');
      updateOverlayProgress(totalRemoved, totalEstimate);
      await sleep(300);
    } else {
      warn('cleanAllAPI: batch FAILED, retrying...');
      await sleep(1000);
      const retryOk = await batchRemoveVideos(auth, ytcfg, batch);
      if (retryOk) {
        totalRemoved += batch.length;
        window.cleanerState.count = totalRemoved;
        dbg('cleanAllAPI: retry SUCCESS, totalRemoved now:', totalRemoved);
        sendCount(totalRemoved);
        sendLog(`${totalRemoved} removed (after retry)`, 'success');
        updateOverlayProgress(totalRemoved, totalEstimate);
      } else {
        err('cleanAllAPI: retry also FAILED. Falling back to UI.');
        sendLog('Batch API failed — using slower UI method', 'warning');
        updateOverlayStatus('switching to slower method...');
        await cleanFallbackUI(totalRemoved);
        return;
      }
    }

    // Next page
    if (page.continuation) {
      continuation = page.continuation;
      dbg('cleanAllAPI: moving to next page');
      await sleep(200);
    } else {
      dbg('cleanAllAPI: no continuation, doing final check');
      const finalPage = await fetchPlaylistPage(auth, ytcfg, null);
      if (finalPage.ids.length === 0) {
        sendLog(`Done! Removed ${totalRemoved} videos.`, 'success');
        sendComplete(totalRemoved);
        completeOverlay(totalRemoved);
        window.cleanerIsRunning = false;
        window.cleanerState.running = false;
        window.cleanerState.done = true;
        window.cleanerState.count = totalRemoved;
        dbg('=== cleanAllAPI DONE (final check) ===', totalRemoved, 'removed');
        return;
      }
      dbg('cleanAllAPI: final check found', finalPage.ids.length, 'more videos, looping');
      continuation = null; // restart from beginning
    }
  }

  dbg('cleanAllAPI: exited loop, cleanerIsRunning:', window.cleanerIsRunning);
}

// --- Fallback: UI-click removal ---

const ICONS = {
  eye: 'M3.132 12.001c3.197-7.95 14.54-7.95 17.736 0-3.197 7.95-14.54 7.95-17.736 0',
  trash: 'M19 3h-4V2a1 1 0 00-1-1h-4a1 1 0 00-1 1v1H5a2 2 0 00-2 2h18a2 2 0 00-2-2Z',
};

function waitForElement(selector, parent = document, timeoutMs = 3000) {
  return new Promise(resolve => {
    const existing = parent.querySelector(selector);
    if (existing) return resolve(existing);
    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
    const observer = new MutationObserver(() => {
      const el = parent.querySelector(selector);
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(parent, { childList: true, subtree: true });
  });
}

async function findWithStrategies(strategies, maxAttempts = 3, delayMs = 200) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    for (const fn of strategies) { const el = fn(); if (el) return el; }
    await sleep(delayMs);
  }
  return null;
}

function findMenuItemBySvg(pathPrefix) {
  for (const item of document.querySelectorAll('ytd-menu-popup-renderer [role="menuitem"]')) {
    if ((item.querySelector('svg path')?.getAttribute('d') || '').startsWith(pathPrefix)) return item;
  }
  return null;
}

function findMenuItemByText(regex) {
  for (const item of document.querySelectorAll('ytd-menu-popup-renderer [role="menuitem"]')) {
    if (regex.test(item.textContent)) return item;
  }
  return null;
}

async function showHiddenVideosUI() {
  dbg('showHiddenVideosUI: starting');
  const btn = await findWithStrategies([
    () => document.querySelector('ytd-playlist-header-renderer ytd-menu-renderer button'),
  ], 3, 500);
  if (!btn) { dbg('showHiddenVideosUI: no menu button found'); return; }

  btn.click();
  const popup = await waitForElement('ytd-menu-popup-renderer tp-yt-paper-listbox', document, 2000);
  if (!popup) { document.body.click(); dbg('showHiddenVideosUI: popup didn\'t open'); return; }
  await sleep(100);

  const opt = await findWithStrategies([
    () => findMenuItemBySvg(ICONS.eye),
    () => findMenuItemByText(/show.*unavailable/i),
  ], 2, 150);

  if (opt) { opt.click(); await sleep(500); dbg('showHiddenVideosUI: clicked show option'); }
  else { document.body.click(); await sleep(200); dbg('showHiddenVideosUI: no show option found'); }
}

async function cleanFallbackUI(startCount) {
  dbg('=== cleanFallbackUI START, startCount:', startCount, '===');
  window.cleanerState.method = 'fallback';
  window.cleanerState.apiFailedAt = startCount;
  if (!window.cleanerIsRunning) { dbg('cleanFallbackUI: not running, exit'); return; }

  const totalEstimate = getPlaylistTotal();
  updateOverlayStatus('using slower method...');

  await showHiddenVideosUI();
  let count = startCount;

  async function removeNext() {
    if (!window.cleanerIsRunning) { dbg('cleanFallbackUI: stopped at count:', count); return; }

    const video = document.querySelector('ytd-playlist-video-renderer');
    if (!video) {
      dbg('cleanFallbackUI: no videos in DOM');
      const countEl = document.querySelector('ytd-playlist-byline-renderer yt-formatted-string.byline-item');
      const text = countEl?.textContent?.trim() || '';
      const m = text.replace(/,/g, '').match(/(\d+)/);
      const remaining = m ? parseInt(m[1]) : 0;
      dbg('cleanFallbackUI: remaining per page count:', remaining);

      if (remaining > 0 && (window.cleanerRefreshAttempts || 0) < 3) {
        window.cleanerRefreshAttempts = (window.cleanerRefreshAttempts || 0) + 1;
        dbg('cleanFallbackUI: refreshing page, attempt:', window.cleanerRefreshAttempts);
        sendLog('Loading more videos...', 'success');
        updateOverlayStatus('loading more videos...');
        window.location.reload();
        return;
      }
      sendLog(`Done! Removed ${count} videos.`, 'success');
      sendComplete(count);
      completeOverlay(count);
      window.cleanerIsRunning = false;
      window.cleanerState.running = false;
      window.cleanerState.done = true;
      window.cleanerState.count = count;
      dbg('=== cleanFallbackUI DONE ===', count, 'removed');
      return;
    }

    window.cleanerRefreshAttempts = 0;
    const menuBtn = await findWithStrategies([
      () => video.querySelector('button[aria-label="Action menu"]'),
      () => video.querySelector('#menu button'),
    ]);
    if (!menuBtn) { await sleep(200); return removeNext(); }

    menuBtn.click();
    const popup = await waitForElement('ytd-menu-popup-renderer tp-yt-paper-listbox', document, 2000);
    if (!popup) { document.body.click(); await sleep(300); return removeNext(); }
    await sleep(50);

    const removeOpt = await findWithStrategies([
      () => findMenuItemBySvg(ICONS.trash),
      () => findMenuItemByText(/remove.*watch\s*later/i),
      () => document.querySelector('ytd-menu-popup-renderer tp-yt-paper-listbox [role="menuitem"]:nth-child(3)'),
    ], 3, 150);

    if (removeOpt) {
      removeOpt.click();
      count++;
      dbg('cleanFallbackUI: removed #' + count);
      sendCount(count);
      window.cleanerState.count = count;
      updateOverlayProgress(count, totalEstimate);
      await sleep(500);
    } else {
      document.body.click();
      dbg('cleanFallbackUI: remove option not found');
      await sleep(500);
    }

    return removeNext();
  }

  await removeNext();
}

// --- Message listener ---

// --- Shared state for popup sync ---

window.cleanerState = { running: false, done: false, count: 0, total: 0, startTime: null, method: null, apiFailedAt: null };

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dbg('onMessage:', message.command);

  // Synchronous status query — popup asks for current state on open
  if (message.command === 'status') {
    dbg('onMessage: status query, returning state:', JSON.stringify(window.cleanerState));
    sendResponse(window.cleanerState);
    return;
  }

  // Log collection for bug reports
  if (message.command === 'getLogs') {
    sendResponse({
      logs: logBuffer.slice(),
      state: window.cleanerState,
      url: window.location.href,
      ua: navigator.userAgent,
    });
    return;
  }

  // All other commands are async
  (async () => {

  if (message.command === 'start') {
    if (!window.location.href.match(/youtube\.com\/playlist\?list=WL/)) {
      sendError('Navigate to your Watch Later playlist first.');
      return;
    }
    if (document.querySelector('a[href*="ServiceLogin"]')) {
      sendError('Please sign in to YouTube first.');
      return;
    }

    // Prevent double-start
    if (window.cleanerIsRunning) {
      dbg('onMessage: already running, ignoring start');
      return;
    }

    try {
      sendLog('Starting...', 'success');
      window.cleanerIsRunning = true;
      window.cleanerRefreshAttempts = 0;
      window.cleanerState = { running: true, done: false, count: 0, total: getPlaylistTotal(), startTime: Date.now(), method: null, apiFailedAt: null };
      dbg('onMessage: cleanerIsRunning = true, state:', JSON.stringify(window.cleanerState));
      createOverlay();
      await cleanAllAPI();
    } catch (error) {
      err('onMessage: uncaught error:', error.message, error.stack);
      sendError(`Error: ${error.message}`);
      destroyOverlay();
      window.cleanerIsRunning = false;
      window.cleanerState.running = false;
    }
  } else if (message.command === 'stop') {
    dbg('onMessage: stopping, cleanerIsRunning was:', window.cleanerIsRunning);
    window.cleanerIsRunning = false;
    window.cleanerState.running = false;
    destroyOverlay();
    sendLog('Stopped.', 'warning');
  } else if (message.command === 'resume') {
    if (window.cleanerIsRunning) {
      dbg('onMessage: already running, ignoring resume');
      return;
    }
    dbg('onMessage: resuming');
    sendLog('Resuming...', 'success');
    window.cleanerIsRunning = true;
    window.cleanerState.running = true;
    await sleep(1000);
    await cleanAllAPI();
  }

  })(); // end async IIFE
});

dbg('Content script loaded on:', window.location.href);
