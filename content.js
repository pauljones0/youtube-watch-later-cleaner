/**
 * YouTube Watch Later Cleaner — Content Script
 * Fully API-driven with UI-click fallback.
 * Heavy logging for debugging.
 */

(() => {
if (window.__youtubeWatchLaterCleanerLoaded) {
  console.log('[WLC]', 'Content script already loaded on:', window.location.href);
  return;
}

window.__youtubeWatchLaterCleanerLoaded = true;
window.__youtubeWatchLaterCleanerVersion = browser.runtime.getManifest().version;

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

const DECISION_TRACE_ENABLED = false;

function traceDecision(context, details) {
  if (!DECISION_TRACE_ENABLED) return;

  const parts = [context];

  if (details.page != null) parts.push(`page=${details.page}`);
  if (details.pass != null) parts.push(`pass=${details.pass}`);
  if (details.index != null) parts.push(`index=${details.index}`);
  if (details.action) parts.push(`action=${details.action}`);
  if (details.reason) parts.push(`reason=${details.reason}`);
  if (details.watchedPercent != null) parts.push(`watched=${details.watchedPercent}%`);
  if (details.threshold != null) parts.push(`threshold=${details.threshold}%`);
  if (details.setVideoId) parts.push(`setVideoId=${details.setVideoId}`);
  if (details.videoKey) parts.push(`videoKey=${details.videoKey}`);
  if (details.title) parts.push(`title="${details.title}"`);

  dbg('[decision]', parts.join(' | '));
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

function sendComplete({ count, remaining, settings }) {
  dbg('sendComplete:', count, 'remaining:', remaining, 'settings:', settings);
  browser.runtime.sendMessage({ type: 'complete', count, remaining, settings }).catch(() => {});
}

// --- Get playlist total from DOM ---

function getPlaylistTotal() {
  const el = document.querySelector('ytd-playlist-byline-renderer yt-formatted-string.byline-item');
  if (!el) return 0;
  const m = el.textContent.trim().replace(/,/g, '').match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

const DEFAULT_SETTINGS = Object.freeze({ minProgressPercent: 0 });
const MAX_BATCH_REMOVE_SIZE = 100;
const BATCH_REMOVE_DELAY_MS = 350;

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function chunkArray(items, chunkSize) {
  if (!Array.isArray(items) || !items.length) return [];
  const size = Math.max(1, Math.floor(chunkSize) || 1);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function normalizeSettings(settings) {
  return {
    minProgressPercent: clampPercent(settings?.minProgressPercent),
  };
}

function getActiveSettings() {
  return normalizeSettings(window.cleanerState?.settings);
}

function isProgressFilteringEnabled(settings = getActiveSettings()) {
  return settings.minProgressPercent > 0;
}

function shouldDeleteVideoByProgress(watchedPercent, settings = getActiveSettings()) {
  return clampPercent(watchedPercent) >= settings.minProgressPercent;
}

function createCleanerState(overrides = {}) {
  return {
    running: false,
    done: false,
    count: 0,
    total: 0,
    remaining: 0,
    matchingEstimate: 0,
    startTime: null,
    completedAt: null,
    method: null,
    apiFailedAt: null,
    popupVisible: false,
    settings: { ...DEFAULT_SETTINGS },
    ...overrides,
  };
}

let estimateCache = null;
let hydrationVisibleBaseline = 0;

function invalidateEstimateCache() {
  estimateCache = null;
}

function getRenderedRowCount() {
  return document.querySelectorAll('ytd-playlist-video-renderer').length;
}

function updateHydrationVisibleBaseline() {
  const rendered = getRenderedRowCount();
  if (rendered > hydrationVisibleBaseline) {
    hydrationVisibleBaseline = rendered;
  }
  return hydrationVisibleBaseline;
}

async function waitForYouTubeConfigForEstimate(maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ytcfg = getYtConfig();
    if (ytcfg) return ytcfg;
    await sleep(250);
  }
  return null;
}

async function buildEstimateCache() {
  const currentTotal = getPlaylistTotal();
  if (estimateCache && estimateCache.total === currentTotal && (Date.now() - estimateCache.createdAt) < 120000) {
    return estimateCache;
  }

  const ytcfg = await waitForYouTubeConfigForEstimate();
  if (!ytcfg) {
    return { ready: false, total: currentTotal, videos: [] };
  }

  const auth = await generateSapisidHash();
  if (!auth) {
    return { ready: false, total: currentTotal, videos: [] };
  }

  let continuation = null;
  const videos = [];
  let guard = 0;

  while (guard < 200) {
    guard++;
    const page = await fetchPlaylistPage(auth, ytcfg, continuation);
    if (page.error) {
      return { ready: false, total: currentTotal, videos };
    }
    if (!page.videos.length) break;
    videos.push(...page.videos);
    if (!page.continuation) break;
    continuation = page.continuation;
  }

  const exactCounts = Array.from({ length: 101 }, () => 0);
  for (const video of videos) {
    exactCounts[clampPercent(video.watchedPercent)]++;
  }

  const countsAtLeast = Array.from({ length: 101 }, () => 0);
  let running = 0;
  for (let pct = 100; pct >= 0; pct--) {
    running += exactCounts[pct];
    countsAtLeast[pct] = running;
  }

  estimateCache = {
    ready: true,
    createdAt: Date.now(),
    total: videos.length || currentTotal,
    videos,
    countsAtLeast,
  };
  return estimateCache;
}

async function estimatePlaylistMatches(settings) {
  const total = getPlaylistTotal();
  if (settings.minProgressPercent === 0) {
    return {
      ready: true,
      matching: total,
      total,
      source: 'dom-total',
      countsAtLeast: null,
    };
  }

  const cache = await buildEstimateCache();
  if (!cache.ready) {
    return {
      ready: false,
      matching: 0,
      total: cache.total || total,
      source: 'unavailable',
      countsAtLeast: cache.countsAtLeast || null,
    };
  }

  const threshold = clampPercent(settings.minProgressPercent);
  const matching = cache.countsAtLeast?.[threshold] ?? cache.videos.filter(video =>
    shouldDeleteVideoByProgress(video.watchedPercent, settings)
  ).length;

  return {
    ready: true,
    matching,
    total: cache.total || total,
    source: 'api-cache',
    countsAtLeast: cache.countsAtLeast || null,
  };
}

function finishCleaning(count, remaining = getPlaylistTotal()) {
  const settings = getActiveSettings();
  invalidateEstimateCache();
  sendLog(`Done! Removed ${count} videos.`, 'success');
  sendComplete({ count, remaining, settings });
  completeOverlay(count, remaining);
  window.cleanerIsRunning = false;
  window.cleanerState = {
    ...window.cleanerState,
    running: false,
    done: true,
    count,
    remaining,
    completedAt: Date.now(),
    settings,
  };
}

// --- On-page progress overlay (shadow DOM) ---

let overlayHost = null;
let overlayRefs = null;
let overlayHideTimer = null;

function setOverlayVisible(visible) {
  if (!overlayHost) return;
  overlayHost.style.display = visible ? 'block' : 'none';
  dbg('setOverlayVisible:', visible);
}

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
  setOverlayVisible(!window.cleanerState?.popupVisible);
  dbg('createOverlay: created');
}

function updateOverlayProgress(removed, total) {
  if (!overlayRefs) return;
  const filteredRun = isProgressFilteringEnabled();
  const estimatedFilteredTotal = Math.max(0, window.cleanerState?.matchingEstimate || 0);
  const effectiveTotal = filteredRun && estimatedFilteredTotal > 0 ? estimatedFilteredTotal : total;

  // Switch to determinate mode
  overlayRefs.barFill.classList.remove('indeterminate');
  overlayRefs.barFill.classList.add('determinate');

  if (effectiveTotal > 0) {
    const pct = Math.min(100, (removed / effectiveTotal) * 100);
    overlayRefs.barFill.style.width = pct + '%';
  } else {
    // No reliable total known yet — grow smoothly without jumping to 100%.
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

function setOverlayBusy(text = null) {
  if (!overlayRefs) return;
  overlayRefs.barFill.classList.remove('determinate');
  overlayRefs.barFill.classList.add('indeterminate');
  overlayRefs.barFill.style.width = '';
  if (text) {
    overlayRefs.label.textContent = text;
  }
}

function updateOverlayStatus(text) {
  if (!overlayRefs) return;
  overlayRefs.label.textContent = text;
}

function shouldDisableCompletionReload(remaining = null) {
  try {
    if (window.WLC_ENABLE_RELOAD === true) return false;
    if (sessionStorage.getItem('WLC_ENABLE_RELOAD') === '1') return false;
    if (localStorage.getItem('WLC_ENABLE_RELOAD') === '1') return false;
    if (window.WLC_DISABLE_RELOAD === true) return true;
    if (sessionStorage.getItem('WLC_DISABLE_RELOAD') === '1') return true;
    if (localStorage.getItem('WLC_DISABLE_RELOAD') === '1') return true;
  } catch (_) {}
  return remaining > 0;
}

function completeOverlay(removed, remaining) {
  if (!overlayRefs) return;
  const disableReload = shouldDisableCompletionReload(remaining);

  overlayRefs.barFill.classList.remove('indeterminate');
  overlayRefs.barFill.classList.add('determinate');
  overlayRefs.barFill.style.width = '100%';

  overlayRefs.count.textContent = removed.toLocaleString();
  overlayRefs.label.textContent = disableReload
    ? (remaining > 0 ? `${remaining.toLocaleString()} kept` : 'finished')
    : (remaining > 0 ? `${remaining.toLocaleString()} kept — refreshing...` : 'videos removed — refreshing...');
  overlayRefs.dot.classList.add('done');

  dbg('completeOverlay:', removed, 'remaining:', remaining);

  // Auto-hide after 3 seconds, then refresh the page unless disabled for debugging.
  overlayHideTimer = setTimeout(() => {
    if (overlayRefs) {
      overlayRefs.toast.classList.add('hidden');
      setTimeout(() => {
        destroyOverlay();
        if (!disableReload) {
          dbg('completeOverlay: refreshing page');
          window.location.reload();
        } else {
          dbg('completeOverlay: reload disabled by debug flag');
        }
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
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch (error) {
    err('pageFetch: failed to parse JSON:', error.message);
    throw new Error(`invalid-json:http-${result.status}`);
  }

  if (parsed && typeof parsed === 'object') {
    parsed._httpStatus = result.status;
  }
  return parsed;
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

function getRendererWatchedPercent(renderer) {
  const overlays = renderer?.thumbnailOverlays || [];
  for (const overlay of overlays) {
    const resume = overlay?.thumbnailOverlayResumePlaybackRenderer;
    if (!resume) continue;
    const percent = resume.percentDurationWatched ?? resume.percentDurationWatchedString;
    return clampPercent(percent);
  }
  return 0;
}

function getRendererVideoId(renderer) {
  return renderer?.videoId
    || renderer?.navigationEndpoint?.watchEndpoint?.videoId
    || null;
}

function getContinuationTokenFromItem(item) {
  const cmds = item?.continuationItemRenderer?.continuationEndpoint?.commandExecutorCommand?.commands;
  return cmds?.find(c => c.continuationCommand)?.continuationCommand?.token
    || item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
    || null;
}

function getContinuationTokenFromItems(items) {
  if (!Array.isArray(items)) return null;
  return getContinuationTokenFromItem(items.find(item => item?.continuationItemRenderer)) || null;
}

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
    return { videos: [], continuation: null, error: e.message };
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
        return { videos: [], continuation: null, error: 'yt-alert: ' + alertText };
      }
    }
  }

  const videos = items
    .filter(i => i.playlistVideoRenderer?.setVideoId)
    .map(i => ({
      setVideoId: i.playlistVideoRenderer.setVideoId,
      videoId: getRendererVideoId(i.playlistVideoRenderer),
      watchedPercent: getRendererWatchedPercent(i.playlistVideoRenderer),
      title: i.playlistVideoRenderer?.title?.runs?.map(r => r.text).join('') || '',
    }));

  const nextToken = getContinuationTokenFromItems(items);

  dbg('fetchPlaylistPage: got', videos.length, 'videos, hasNext:', !!nextToken);
  return { videos, continuation: nextToken, error: null };
}

async function fetchPlaylistContinuationItems(auth, ytcfg, continuationToken) {
  if (!continuationToken) {
    return { items: [], continuation: null, error: 'missing-continuation-token' };
  }

  let rb;
  try {
    rb = await pageFetch(
      `https://www.youtube.com/youtubei/v1/browse?key=${ytcfg.apiKey}&prettyPrint=false`,
      getApiHeaders(auth),
      JSON.stringify({ context: ytcfg.context, continuation: continuationToken })
    );
  } catch (error) {
    err('fetchPlaylistContinuationItems: error:', error.message);
    return { items: [], continuation: null, error: error.message };
  }

  const appendAction = rb.onResponseReceivedActions?.find(action => action.appendContinuationItemsAction);
  const items = appendAction?.appendContinuationItemsAction?.continuationItems || [];
  const nextToken = getContinuationTokenFromItems(items);

  dbg('fetchPlaylistContinuationItems: got', items.length, 'items, hasNext:', !!nextToken);
  return { items, continuation: nextToken, error: null };
}

async function findVideosInPlaylist(auth, ytcfg, ids, keySelector, maxPages = 50) {
  const pendingIds = new Set((ids || []).filter(Boolean));
  const foundIds = new Set();

  if (!pendingIds.size) {
    return { foundIds, pagesScanned: 0, completed: true, error: null };
  }

  let continuation = null;
  let pagesScanned = 0;

  while (pendingIds.size && pagesScanned < maxPages) {
    const page = await fetchPlaylistPage(auth, ytcfg, continuation);
    pagesScanned++;

    if (page.error) {
      return { foundIds, pagesScanned, completed: false, error: page.error };
    }

    for (const video of page.videos) {
      const key = keySelector(video);
      if (!key || !pendingIds.has(key)) continue;
      foundIds.add(key);
      pendingIds.delete(key);
    }

    if (!page.continuation) {
      return { foundIds, pagesScanned, completed: true, error: null };
    }

    continuation = page.continuation;
  }

  return {
    foundIds,
    pagesScanned,
    completed: pendingIds.size === 0,
    error: null,
  };
}

async function findSetVideoIdsInPlaylist(auth, ytcfg, setVideoIds, maxPages = 50) {
  return findVideosInPlaylist(auth, ytcfg, setVideoIds, video => video?.setVideoId, maxPages);
}

async function findVideoIdsInPlaylist(auth, ytcfg, videoIds, maxPages = 50) {
  return findVideosInPlaylist(auth, ytcfg, videoIds, video => video?.videoId, maxPages);
}

// --- Batch remove (via page-context fetch) ---

async function batchRemoveVideos(auth, ytcfg, setVideoIds) {
  dbg('batchRemoveVideos: removing', setVideoIds.length, 'videos');

  const body = {
    context: ytcfg.context,
    playlistId: 'WL',
    actions: setVideoIds.map(id => ({ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' })),
    params: 'CAFAAQ==',
    clientActions: [
      {
        playlistRemoveVideosAction: {
          setVideoIds,
        },
      },
    ],
  };

  try {
    const rb = await pageFetch(
      `https://www.youtube.com/youtubei/v1/browse/edit_playlist?key=${ytcfg.apiKey}&prettyPrint=false`,
      getApiHeaders(auth),
      JSON.stringify(body)
    );
    const ok = rb?.status === 'STATUS_SUCCEEDED';
    dbg(
      'batchRemoveVideos: ok:', ok,
      '| http:', rb?._httpStatus,
      '| status:', rb?.status,
      '| error:', rb?.error ? JSON.stringify(rb.error) : 'none'
    );
    return { ok, response: rb, error: null };
  } catch (e) {
    err('batchRemoveVideos: error:', e.message);
    return { ok: false, response: null, error: e.message };
  }
}

// --- Main cleaning loop ---

async function cleanAllAPI() {
  dbg('=== cleanAllAPI START ===');
  updateHydrationVisibleBaseline();
  window.cleanerState.method = 'api';
  const settings = getActiveSettings();

  const ytcfg = await waitForYouTubeReady();
  if (!ytcfg) {
    if (!window.cleanerIsRunning) return; // stopped during wait
    warn('cleanAllAPI: ytcfg unavailable, falling back to UI');
    sendLog('YouTube config not available — using slower UI method', 'warning');
    updateOverlayStatus('switching to slower method...');
    await cleanFallbackUI(window.cleanerState.count || 0);
    return;
  }

  const auth = await generateSapisidHash();
  if (!auth) {
    warn('cleanAllAPI: no auth, falling back to UI');
    sendLog('Auth unavailable — using slower UI method', 'warning');
    updateOverlayStatus('switching to slower method...');
    await cleanFallbackUI(window.cleanerState.count || 0);
    return;
  }

  let totalRemoved = window.cleanerState.count || 0;
  const totalEstimate = getPlaylistTotal();
  dbg('cleanAllAPI: totalEstimate from DOM:', totalEstimate);

  sendLog(
    isProgressFilteringEnabled(settings)
      ? `Fetching playlist and filtering videos watched at least ${settings.minProgressPercent}%...`
      : 'Fetching playlist...',
    'success'
  );
  updateOverlayStatus(
    isProgressFilteringEnabled(settings)
      ? 'scanning playlist...'
      : 'fetching playlist...'
  );

  let passNum = 0;

  while (window.cleanerIsRunning) {
    passNum++;
    let continuation = null;
    let pageNum = 0;
    let removedThisPass = 0;

    dbg('--- Pass', passNum, '| totalRemoved:', totalRemoved, '---');

    while (window.cleanerIsRunning) {
      pageNum++;
      dbg('--- Page', pageNum, '| pass:', passNum, '| continuation:', !!continuation, '---');

      const page = await fetchPlaylistPage(auth, ytcfg, continuation);

      if (page.videos.length === 0) {
        dbg('cleanAllAPI: no videos on page', pageNum);

        if (passNum === 1 && totalRemoved === 0 && !continuation) {
          const domCount = getPlaylistTotal();
          if (domCount > 0) {
            warn('cleanAllAPI: API returned 0 videos but DOM shows', domCount, '— falling back to UI');
            if (page.error) {
              sendLog(`API error (${page.error}) — using slower UI method`, 'warning');
            } else {
              sendLog('API returned empty — using slower UI method', 'warning');
            }
            updateOverlayStatus('switching to slower method...');
            await cleanFallbackUI(totalRemoved);
            return;
          }
          sendLog('Playlist is already empty.', 'success');
        }
        break;
      }

      if (!window.cleanerIsRunning) {
        dbg('cleanAllAPI: stopped before evaluating page at totalRemoved:', totalRemoved);
        return;
      }

      for (let i = 0; i < page.videos.length; i++) {
        const video = page.videos[i];
        traceDecision('api-evaluate', {
          pass: passNum,
          page: pageNum,
          index: i,
          action: shouldDeleteVideoByProgress(video.watchedPercent, settings) ? 'delete' : 'keep',
          reason: shouldDeleteVideoByProgress(video.watchedPercent, settings) ? 'matched-threshold' : 'below-threshold',
          watchedPercent: video.watchedPercent,
          threshold: settings.minProgressPercent,
          setVideoId: video.setVideoId,
          title: video.title,
        });
      }

      const deletableVideos = page.videos.filter(video =>
        shouldDeleteVideoByProgress(video.watchedPercent, settings)
      );
      const batch = deletableVideos.map(video => video.setVideoId);

      dbg(
        'cleanAllAPI: page',
        pageNum,
        '| total videos:',
        page.videos.length,
        '| deletable:',
        batch.length,
        '| threshold:',
        settings.minProgressPercent
      );

      if (batch.length > 0) {
        const deleteChunks = chunkArray(deletableVideos, MAX_BATCH_REMOVE_SIZE);
        dbg('cleanAllAPI: splitting deletions into', deleteChunks.length, 'chunk(s) of up to', MAX_BATCH_REMOVE_SIZE);

        for (let chunkIndex = 0; chunkIndex < deleteChunks.length; chunkIndex++) {
          const chunkVideos = deleteChunks[chunkIndex];
          const chunkSetVideoIds = chunkVideos.map(video => video.setVideoId);

          sendLog(
            deleteChunks.length > 1
              ? `Removing ${chunkSetVideoIds.length} videos... (${chunkIndex + 1}/${deleteChunks.length})`
              : `Removing ${chunkSetVideoIds.length} videos...`,
            'success'
          );
          updateOverlayStatus(
            totalRemoved > 0
              ? `removed — processing batch ${chunkIndex + 1}/${deleteChunks.length}...`
              : `processing ${chunkSetVideoIds.length} videos...`
          );
          setOverlayBusy(
            deleteChunks.length > 1
              ? `processing batch ${chunkIndex + 1}/${deleteChunks.length}...`
              : 'processing videos...'
          );

          const applyDeletedChunk = async (deletedChunkVideos, resultReason, response = null) => {
            if (!deletedChunkVideos.length) return;

            await reconcilePlaylistAfterBatch(deletedChunkVideos, { auth, ytcfg }, response);
            for (const video of deletedChunkVideos) {
              traceDecision('api-delete-result', {
                pass: passNum,
                page: pageNum,
                action: 'deleted',
                reason: resultReason,
                watchedPercent: video.watchedPercent,
                threshold: settings.minProgressPercent,
                setVideoId: video.setVideoId,
                title: video.title,
              });
            }
            totalRemoved += deletedChunkVideos.length;
            removedThisPass += deletedChunkVideos.length;
            window.cleanerState.count = totalRemoved;
            window.cleanerState.remaining = Math.max(0, window.cleanerState.remaining || getPlaylistTotal());
            dbg('cleanAllAPI: batch SUCCESS, totalRemoved now:', totalRemoved, '| reason:', resultReason);
            sendCount(totalRemoved);
            sendLog(`${totalRemoved} removed`, 'success');
            updateOverlayProgress(totalRemoved, totalEstimate);
          };

          const batchResult = await batchRemoveVideos(auth, ytcfg, chunkSetVideoIds);

          if (batchResult.ok) {
            await applyDeletedChunk(chunkVideos, 'batch-succeeded', batchResult.response);
            await sleep(BATCH_REMOVE_DELAY_MS);
          } else {
            warn(
              'cleanAllAPI: batch FAILED, retrying...',
              '| chunk:',
              `${chunkIndex + 1}/${deleteChunks.length}`,
              '| http:',
              batchResult.response?._httpStatus,
              '| status:',
              batchResult.response?.status,
              '| error:',
              batchResult.error || JSON.stringify(batchResult.response?.error || null)
            );
            setOverlayBusy('verifying deletions...');
            const verification = await findSetVideoIdsInPlaylist(auth, ytcfg, chunkSetVideoIds);
            const stillPresentSetVideoIds = new Set(verification.foundIds);
            const alreadyRemovedVideos = chunkVideos.filter(video => !stillPresentSetVideoIds.has(video.setVideoId));
            const retryVideos = chunkVideos.filter(video => stillPresentSetVideoIds.has(video.setVideoId));

            dbg('cleanAllAPI: failure verification result:', {
              chunk: `${chunkIndex + 1}/${deleteChunks.length}`,
              pagesScanned: verification.pagesScanned,
              verificationCompleted: verification.completed,
              verificationError: verification.error,
              alreadyRemoved: alreadyRemovedVideos.length,
              stillPresent: retryVideos.length,
            });

            if (alreadyRemovedVideos.length > 0) {
              await applyDeletedChunk(alreadyRemovedVideos, 'batch-verified-after-error');
            }

            if (!retryVideos.length) {
              await sleep(BATCH_REMOVE_DELAY_MS);
              continue;
            }

            await sleep(1000);
            setOverlayBusy('retrying failed deletions...');
            const retrySetVideoIds = retryVideos.map(video => video.setVideoId);
            const retryResult = await batchRemoveVideos(auth, ytcfg, retrySetVideoIds);
            if (retryResult.ok) {
              await applyDeletedChunk(retryVideos, 'batch-retry-succeeded', retryResult.response);
              await sleep(BATCH_REMOVE_DELAY_MS);
            } else {
              setOverlayBusy('verifying retry result...');
              const retryVerification = await findSetVideoIdsInPlaylist(auth, ytcfg, retrySetVideoIds);
              const stillPresentAfterRetry = new Set(retryVerification.foundIds);
              const retryRemovedVideos = retryVideos.filter(video => !stillPresentAfterRetry.has(video.setVideoId));
              const failedVideos = retryVideos.filter(video => stillPresentAfterRetry.has(video.setVideoId));

              if (retryRemovedVideos.length > 0) {
                await applyDeletedChunk(retryRemovedVideos, 'batch-retry-verified-after-error');
              }

              if (!failedVideos.length) {
                await sleep(BATCH_REMOVE_DELAY_MS);
                continue;
              }

              for (const video of failedVideos) {
                traceDecision('api-delete-result', {
                  pass: passNum,
                  page: pageNum,
                  action: 'failed',
                  reason: 'batch-and-retry-failed',
                  watchedPercent: video.watchedPercent,
                  threshold: settings.minProgressPercent,
                  setVideoId: video.setVideoId,
                  title: video.title,
                });
              }
              err(
                'cleanAllAPI: retry also FAILED. Falling back to UI.',
                '| chunk:',
                `${chunkIndex + 1}/${deleteChunks.length}`,
                '| http:',
                retryResult.response?._httpStatus,
                '| status:',
                retryResult.response?.status,
                '| error:',
                retryResult.error || JSON.stringify(retryResult.response?.error || null)
              );
              sendLog('Batch API failed — using slower UI method', 'warning');
              updateOverlayStatus('switching to slower method...');
              await cleanFallbackUI(totalRemoved);
              return;
            }
          }
        }
      } else if (isProgressFilteringEnabled(settings)) {
        updateOverlayStatus(`keeping videos below ${settings.minProgressPercent}%...`);
        await sleep(100);
      }

      if (page.continuation) {
        continuation = page.continuation;
        dbg('cleanAllAPI: moving to next page');
        await sleep(200);
      } else {
        dbg('cleanAllAPI: end of pass', passNum, '| removedThisPass:', removedThisPass);
        break;
      }
    }

    if (!window.cleanerIsRunning) {
      dbg('cleanAllAPI: exited loop, cleanerIsRunning:', window.cleanerIsRunning);
      return;
    }

    if (removedThisPass === 0) {
      const remaining = getPlaylistTotal();
      finishCleaning(totalRemoved, remaining);
      dbg('=== cleanAllAPI DONE ===', totalRemoved, 'removed, remaining:', remaining);
      return;
    }

    sendLog('Checking for more matching videos...', 'success');
    updateOverlayStatus('rescanning playlist...');
    await sleep(300);
  }
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

function getVideoRowKey(video, index = 0) {
  const href = video.querySelector('a#thumbnail[href*="watch?v="], a[href*="/watch?v="]')?.href
    || video.querySelector('a#video-title[href*="watch?v="]')?.href
    || '';

  if (href) {
    try {
      const url = new URL(href, window.location.origin);
      const id = url.searchParams.get('v');
      if (id) return id;
    } catch (_) {}
  }

  const title = video.querySelector('#video-title')?.textContent?.trim();
  return title ? `title:${title}:${index}` : `row:${index}`;
}

function getVideoIdFromRow(video) {
  const href = video.querySelector('a#thumbnail[href*="watch?v="], a#video-title[href*="watch?v="], a[href*="/watch?v="]')?.href || '';
  if (!href) return null;
  try {
    return new URL(href, window.location.origin).searchParams.get('v');
  } catch (_) {
    return null;
  }
}

function getVideoWatchedPercentFromDOM(video) {
  const progress = video.querySelector('ytd-thumbnail-overlay-resume-playback-renderer #progress, #progress.style-scope.ytd-thumbnail-overlay-resume-playback-renderer');
  const inlineWidth = progress?.style?.width || progress?.getAttribute('style') || '';
  const match = inlineWidth.match(/([0-9.]+)%/);
  return clampPercent(match ? match[1] : 0);
}

function getVideoRowInfo(video, index = 0) {
  return {
    key: getVideoRowKey(video, index),
    videoId: getVideoIdFromRow(video),
    watchedPercent: getVideoWatchedPercentFromDOM(video),
    title: video.querySelector('#video-title')?.textContent?.trim() || '',
  };
}

function updatePlaylistBylineCount(nextCount) {
  const nodes = document.querySelectorAll([
    'ytd-playlist-byline-renderer yt-formatted-string.byline-item',
    'ytd-playlist-header-renderer yt-formatted-string',
    'yt-content-metadata-view-model .yt-core-attributed-string',
  ].join(', '));
  for (const node of nodes) {
    const text = node.textContent || '';
    if (!/\d/.test(text) || !/\bvideos?\b/i.test(text)) continue;
    node.textContent = text.replace(/\d[\d,]*/, nextCount.toLocaleString());
  }
}

function reconcilePlaylistRemovalCount(removedCount) {
  if (removedCount <= 0) return;
  const current = getPlaylistTotal();
  if (current <= 0) return;
  updatePlaylistBylineCount(Math.max(0, current - removedCount));
}

function parseCountFromText(text) {
  const match = String(text || '').replace(/,/g, '').match(/(\d+)/);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) ? count : null;
}

function parseCountFromTextContainer(container) {
  if (!container) return null;

  if (typeof container.simpleText === 'string') {
    const count = parseCountFromText(container.simpleText);
    if (count !== null) return count;
  }

  if (Array.isArray(container.runs)) {
    for (const run of container.runs) {
      const count = parseCountFromText(run?.text);
      if (count !== null) return count;
    }
  }

  return null;
}

function getPlaylistCountFromEditResponse(response) {
  const headerCount = parseCountFromTextContainer(response?.newHeader?.playlistHeaderRenderer?.numVideosText);
  if (headerCount !== null) return headerCount;

  const headerStatsCount = parseCountFromTextContainer(response?.newHeader?.playlistHeaderRenderer?.stats?.[0]);
  if (headerStatsCount !== null) return headerStatsCount;

  const actionCount = response?.actions
    ?.map(action => action?.updatePlaylistAction?.updatedRenderer?.playlistSidebarPrimaryInfoRenderer?.stats?.[0])
    .map(parseCountFromTextContainer)
    .find(count => count !== null);
  if (actionCount !== undefined) return actionCount;

  return null;
}

function applyPlaylistEditResponse(response, fallbackRemovedCount = 0) {
  const nextCount = getPlaylistCountFromEditResponse(response);

  if (nextCount !== null) {
    updatePlaylistBylineCount(nextCount);
    if (window.cleanerState) {
      window.cleanerState.remaining = nextCount;
    }
    return { source: 'response', count: nextCount };
  }

  if (fallbackRemovedCount > 0) {
    reconcilePlaylistRemovalCount(fallbackRemovedCount);
    const current = getPlaylistTotal();
    if (window.cleanerState && current > 0) {
      window.cleanerState.remaining = current;
    }
    return { source: 'fallback', count: current > 0 ? current : null };
  }

  return { source: 'none', count: null };
}

function getPlaylistListController() {
  const list = document.querySelector('ytd-playlist-video-list-renderer');
  return list?.polymerController || list || null;
}

function getPlaylistListElement() {
  return document.querySelector('ytd-playlist-video-list-renderer');
}

function getPlaylistContentsArray(controller = getPlaylistListController()) {
  const list = getPlaylistListElement();
  const candidates = [
    list?.data?.contents,
    controller?.data?.contents,
    controller?.__data?.data?.contents,
  ];

  for (const contents of candidates) {
    if (Array.isArray(contents)) return contents;
  }
  return null;
}

function getPlaylistItemRenderer(item) {
  return item?.playlistVideoRenderer || null;
}

function getPlaylistItemVideoId(item) {
  const renderer = getPlaylistItemRenderer(item);
  return renderer ? getRendererVideoId(renderer) : null;
}

function getPlaylistItemSetVideoId(item) {
  return getPlaylistItemRenderer(item)?.setVideoId || null;
}

function countHydratedVideoEntries(contents = getPlaylistContentsArray()) {
  if (!Array.isArray(contents)) return 0;
  return contents.filter(item => !!getPlaylistItemSetVideoId(item)).length;
}

function hasHydrationContinuation(contents = getPlaylistContentsArray()) {
  if (!Array.isArray(contents)) return false;
  return contents.some(item => !!item?.continuationItemRenderer);
}

function syncPlaylistContentsReference(contents) {
  if (!Array.isArray(contents)) return;

  const list = getPlaylistListElement();
  const controller = getPlaylistListController();

  try {
    if (list?.data && list.data.contents !== contents) {
      list.data.contents = contents;
    }
  } catch (_) {}

  try {
    if (controller?.data && controller.data.contents !== contents) {
      controller.data.contents = contents;
    }
  } catch (_) {}

  try {
    if (typeof controller?.notifyPath === 'function') {
      controller.notifyPath('data.contents', contents);
    }
  } catch (error) {
    warn('syncPlaylistContentsReference: controller.notifyPath failed:', error.message);
  }

  try {
    if (typeof list?.notifyPath === 'function') {
      list.notifyPath('data.contents', contents);
    }
  } catch (_) {}
}

function notifyPlaylistContentsMutated(controller, contents, reason = 'unknown') {
  syncPlaylistContentsReference(contents);

  if (typeof controller?.updateIndices === 'function') {
    try {
      controller.updateIndices();
    } catch (error) {
      warn(`notifyPlaylistContentsMutated(${reason}): updateIndices failed:`, error.message);
    }
  }
}

function splicePlaylistContents(start, deleteCount, insertItems = [], reason = 'unknown') {
  const controller = getPlaylistListController();
  const list = getPlaylistListElement();
  const contents = getPlaylistContentsArray(controller);

  if (!Array.isArray(contents)) {
    return { ok: false, reason: 'no-contents', removedItems: [], inserted: insertItems.length };
  }

  const safeStart = Math.max(0, Math.min(start, contents.length));
  const normalizedItems = Array.isArray(insertItems) ? insertItems : [];
  const removedItems = contents.slice(safeStart, safeStart + deleteCount);
  const mutationTarget = controller && typeof controller.splice === 'function'
    ? controller
    : (list && typeof list.splice === 'function' ? list : null);

  if (mutationTarget) {
    try {
      mutationTarget.splice('data.contents', safeStart, deleteCount, ...normalizedItems);
      notifyPlaylistContentsMutated(controller, getPlaylistContentsArray(controller) || contents, reason);
      return { ok: true, reason: 'polymer-splice', removedItems, inserted: normalizedItems.length };
    } catch (error) {
      warn(`splicePlaylistContents(${reason}): polymer splice failed:`, error.message);
    }
  }

  contents.splice(safeStart, deleteCount, ...normalizedItems);
  notifyPlaylistContentsMutated(controller, contents, reason);
  return { ok: true, reason: 'array-splice', removedItems, inserted: normalizedItems.length };
}

function getPlaylistContinuationItemIndex(contents = getPlaylistContentsArray()) {
  if (!Array.isArray(contents)) return -1;
  return contents.findIndex(item => !!item?.continuationItemRenderer);
}

function getPlaylistContinuationToken(contents = getPlaylistContentsArray()) {
  const continuationIndex = getPlaylistContinuationItemIndex(contents);
  if (continuationIndex < 0) return null;
  return getContinuationTokenFromItem(contents[continuationIndex]);
}

function removeVisibleRowsByVideoIds(videoIds) {
  if (!videoIds.size) return 0;
  let removed = 0;
  for (const row of Array.from(document.querySelectorAll('ytd-playlist-video-renderer'))) {
    const videoId = getVideoIdFromRow(row);
    if (!videoId || !videoIds.has(videoId)) continue;
    row.remove();
    removed++;
  }
  return removed;
}

function removeVideosFromHydratedList(deletedVideos) {
  const controller = getPlaylistListController();
  const contents = getPlaylistContentsArray(controller);

  if (!Array.isArray(contents)) {
    return { removed: 0, mode: 'unavailable' };
  }

  const videoIds = new Set(deletedVideos.map(video => video.videoId).filter(Boolean));
  const setVideoIds = new Set(deletedVideos.map(video => video.setVideoId).filter(Boolean));
  const indexes = [];

  for (let i = 0; i < contents.length; i++) {
    const item = contents[i];
    const setVideoId = getPlaylistItemSetVideoId(item);
    if (!setVideoId) continue;

    const videoId = getPlaylistItemVideoId(item);
    if (setVideoIds.has(setVideoId) || (videoId && videoIds.has(videoId))) {
      indexes.push(i);
    }
  }

  if (!indexes.length) {
    return { removed: 0, mode: 'hydrated' };
  }

  for (let i = indexes.length - 1; i >= 0; i--) {
    splicePlaylistContents(indexes[i], 1, [], 'remove-hydrated-videos');
  }

  return { removed: indexes.length, mode: 'hydrated' };
}

function applyPlaylistContinuationItems(continuationItems, reason = 'unknown') {
  const controller = getPlaylistListController();
  const contents = getPlaylistContentsArray(controller);
  if (!Array.isArray(contents)) {
    return { applied: false, reason: 'no-contents' };
  }

  const continuationIndex = getPlaylistContinuationItemIndex(contents);
  if (continuationIndex < 0) {
    return { applied: false, reason: 'no-continuation-item' };
  }

  const items = Array.isArray(continuationItems) ? continuationItems : [];
  splicePlaylistContents(continuationIndex, 1, items, `apply-continuation:${reason}`);

  return {
    applied: true,
    reason: 'merged',
    replacedIndex: continuationIndex,
    inserted: items.length,
    videoCount: countHydratedVideoEntries(getPlaylistContentsArray(controller)),
    hasContinuation: hasHydrationContinuation(getPlaylistContentsArray(controller)),
  };
}

async function ensureHydrationApiContext(apiContext) {
  const ytcfg = apiContext?.ytcfg || await waitForYouTubeReady(4000);
  if (!ytcfg) {
    return { ytcfg: null, auth: null, error: 'no-ytcfg' };
  }

  const auth = apiContext?.auth || await generateSapisidHash();
  if (!auth) {
    return { ytcfg, auth: null, error: 'no-auth' };
  }

  return { ytcfg, auth, error: null };
}

async function requestHydrationTopUp(targetVisibleRows, reason = 'unknown', apiContext = null) {
  const remainingRows = getPlaylistTotal();
  const desiredRows = remainingRows > 0
    ? Math.min(Math.max(targetVisibleRows, updateHydrationVisibleBaseline()), remainingRows)
    : Math.max(targetVisibleRows, updateHydrationVisibleBaseline());
  let renderedRows = getRenderedRowCount();
  if (renderedRows >= desiredRows) {
    return { requested: false, reason: 'already-filled', renderedRows, desiredRows, remainingRows };
  }

  const api = await ensureHydrationApiContext(apiContext);
  if (api.error) {
    return { requested: false, reason: api.error, renderedRows, desiredRows, remainingRows };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = getPlaylistListController();
    const contentsBefore = getPlaylistContentsArray(controller);
    const loadedBefore = countHydratedVideoEntries(contentsBefore);
    const continuationToken = getPlaylistContinuationToken(contentsBefore);

    if (!continuationToken) {
      return { requested: false, reason: 'no-continuation', renderedRows, loadedBefore, desiredRows, remainingRows };
    }

    dbg('requestHydrationTopUp: attempt', attempt, '| reason:', reason, '| rendered:', renderedRows, '| loaded:', loadedBefore, '| target:', targetVisibleRows, '| desired:', desiredRows, '| baseline:', hydrationVisibleBaseline, '| remaining:', remainingRows);

    const continuation = await fetchPlaylistContinuationItems(api.auth, api.ytcfg, continuationToken);
    if (continuation.error) {
      return { requested: true, reason: 'continuation-error', error: continuation.error };
    }

    if (!continuation.items.length) {
      return { requested: true, reason: 'empty-continuation', renderedRows, loadedBefore, desiredRows };
    }

    const applied = applyPlaylistContinuationItems(continuation.items, `${reason}:${attempt}`);
    if (!applied.applied) {
      return { requested: true, reason: `apply-failed:${applied.reason}`, renderedRows, loadedBefore, desiredRows };
    }

    await waitForCondition(() => {
      const nowLoaded = countHydratedVideoEntries(getPlaylistContentsArray(getPlaylistListController()));
      const nowRendered = getRenderedRowCount();
      return nowRendered > renderedRows || nowLoaded > loadedBefore;
    }, 2500, 100);

    renderedRows = getRenderedRowCount();
    const loadedRows = countHydratedVideoEntries(getPlaylistContentsArray(getPlaylistListController()));
    updateHydrationVisibleBaseline();
    if (renderedRows >= desiredRows) {
      return { requested: true, reason: 'filled', renderedRows, desiredRows, loadedRows };
    }

    if (loadedRows <= loadedBefore) {
      return { requested: true, reason: 'no-growth', renderedRows, desiredRows, loadedRows };
    }
  }

  return {
    requested: true,
    reason: 'partial',
    renderedRows: getRenderedRowCount(),
    loadedRows: countHydratedVideoEntries(getPlaylistContentsArray(getPlaylistListController())),
    desiredRows,
    baselineRows: hydrationVisibleBaseline,
  };
}

async function reconcilePlaylistAfterBatch(deletedVideos, apiContext = null, editResponse = null) {
  const countUpdate = applyPlaylistEditResponse(editResponse, deletedVideos.length);
  const targetVisibleRows = updateHydrationVisibleBaseline();
  const hydrated = removeVideosFromHydratedList(deletedVideos);
  const videoIds = new Set(deletedVideos.map(video => video.videoId).filter(Boolean));
  const removedVisible = hydrated.removed > 0 ? 0 : removeVisibleRowsByVideoIds(videoIds);

  const topUp = await requestHydrationTopUp(targetVisibleRows, 'batch-delete', apiContext);
  dbg('reconcilePlaylistAfterBatch:', {
    deleted: deletedVideos.length,
    countUpdate,
    hydratedRemoved: hydrated.removed,
    removedVisible,
    baselineRows: hydrationVisibleBaseline,
    renderedRows: getRenderedRowCount(),
    topUp,
  });
}

async function reconcileAfterSingleVisibleRemoval() {
  reconcilePlaylistRemovalCount(1);
  const currentRows = updateHydrationVisibleBaseline();
  const topUp = await requestHydrationTopUp(currentRows + 1, 'ui-delete');
  dbg('reconcileAfterSingleVisibleRemoval:', { topUp });
}

async function waitForCondition(fn, timeoutMs = 2500, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function confirmFallbackRemoval(videoInfo, apiContext, previousTotal) {
  const initialDelay = previousTotal > 0 ? 1200 : 250;
  if (initialDelay > 0) {
    await sleep(initialDelay);
  }

  const currentTotal = getPlaylistTotal();
  if (previousTotal > 0 && currentTotal < previousTotal) {
    dbg('confirmFallbackRemoval: confirmed by playlist count drop', {
      videoId: videoInfo?.videoId || null,
      previousTotal,
      currentTotal,
    });
    return { ok: true, reason: 'count-decremented' };
  }

  if (videoInfo?.videoId && apiContext?.auth && apiContext?.ytcfg) {
    const verification = await findVideoIdsInPlaylist(apiContext.auth, apiContext.ytcfg, [videoInfo.videoId], 20);
    if (verification.error) {
      warn('confirmFallbackRemoval: playlist scan failed after row disappeared', {
        videoId: videoInfo.videoId,
        previousTotal,
        currentTotal,
        verificationError: verification.error,
      });
      return {
        ok: false,
        reason: `playlist-scan-error:${verification.error}`,
        verification,
      };
    }
    const stillPresent = verification.foundIds.has(videoInfo.videoId);
    if (stillPresent) {
      warn('confirmFallbackRemoval: row disappeared but playlist scan still shows video present', {
        videoId: videoInfo.videoId,
        previousTotal,
        currentTotal,
        pagesScanned: verification.pagesScanned,
        completed: verification.completed,
      });
    } else {
      dbg('confirmFallbackRemoval: confirmed by playlist scan after row disappeared', {
        videoId: videoInfo.videoId,
        previousTotal,
        currentTotal,
        pagesScanned: verification.pagesScanned,
        completed: verification.completed,
      });
    }
    return {
      ok: !stillPresent,
      reason: stillPresent ? 'playlist-scan-still-present' : 'playlist-scan-confirmed',
      verification,
    };
  }

  warn('confirmFallbackRemoval: row disappeared but no API verification context was available', {
    videoId: videoInfo?.videoId || null,
    previousTotal,
    currentTotal,
  });
  return {
    ok: true,
    reason: 'dom-only-unverified',
  };
}

async function removeVideoViaMenu(video, videoInfo = null, apiContext = null) {
  const previousTotal = getPlaylistTotal();
  const menuBtn = await findWithStrategies([
    () => video.querySelector('button[aria-label="Action menu"]'),
    () => video.querySelector('#menu button'),
  ]);
  if (!menuBtn) return { ok: false, reason: 'missing-menu-button' };

  menuBtn.click();
  const popup = await waitForElement('ytd-menu-popup-renderer tp-yt-paper-listbox', document, 2000);
  if (!popup) {
    document.body.click();
    await sleep(300);
    return { ok: false, reason: 'menu-popup-missing' };
  }
  await sleep(50);

  const removeOpt = await findWithStrategies([
    () => findMenuItemBySvg(ICONS.trash),
    () => findMenuItemByText(/remove.*watch\s*later/i),
    () => document.querySelector('ytd-menu-popup-renderer tp-yt-paper-listbox [role="menuitem"]:nth-child(3)'),
  ], 3, 150);

  if (!removeOpt) {
    document.body.click();
    return { ok: false, reason: 'remove-option-missing' };
  }

  removeOpt.click();
  const rowDisconnected = await waitForCondition(() => !video.isConnected, 3000, 100);
  if (!rowDisconnected) {
    return { ok: false, reason: 'row-did-not-disappear' };
  }

  return confirmFallbackRemoval(videoInfo, apiContext, previousTotal);
}

async function scrollForMoreRows() {
  const videos = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));
  const beforeHeight = document.documentElement.scrollHeight;
  const beforeY = window.scrollY;
  const beforeLastKey = videos.length ? getVideoRowKey(videos[videos.length - 1], videos.length - 1) : '';

  if (videos.length) {
    videos[videos.length - 1].scrollIntoView({ block: 'end' });
  }
  window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.85)));
  await sleep(900);

  const afterVideos = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));
  const afterHeight = document.documentElement.scrollHeight;
  const afterLastKey = afterVideos.length ? getVideoRowKey(afterVideos[afterVideos.length - 1], afterVideos.length - 1) : '';

  return afterHeight > beforeHeight || window.scrollY > beforeY + 10 || afterLastKey !== beforeLastKey || afterVideos.length > videos.length;
}

async function cleanFallbackUI(startCount) {
  dbg('=== cleanFallbackUI START, startCount:', startCount, '===');
  updateHydrationVisibleBaseline();
  window.cleanerState.method = 'fallback';
  window.cleanerState.apiFailedAt = startCount;
  if (!window.cleanerIsRunning) { dbg('cleanFallbackUI: not running, exit'); return; }

  const settings = getActiveSettings();
  const totalEstimate = getPlaylistTotal();
  const fallbackApiContext = await ensureHydrationApiContext();
  if (fallbackApiContext.error) {
    warn('cleanFallbackUI: verification context unavailable:', fallbackApiContext.error);
  }
  updateOverlayStatus(
    isProgressFilteringEnabled(settings)
      ? 'using slower filtered method...'
      : 'using slower method...'
  );

  await showHiddenVideosUI();
  let count = startCount;
  const keptKeys = new Set();
  const failedAttempts = new Map();
  let idleScrolls = 0;

  while (window.cleanerIsRunning) {
    const videos = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));

    if (!videos.length) {
      dbg('cleanFallbackUI: no videos in DOM');
      const remaining = getPlaylistTotal();
      if (remaining > 0 && idleScrolls < 3) {
        idleScrolls++;
        sendLog('Loading more videos...', 'success');
        updateOverlayStatus('loading more videos...');
        await scrollForMoreRows();
        continue;
      }

      finishCleaning(count, remaining);
      dbg('=== cleanFallbackUI DONE ===', count, 'removed, remaining:', remaining);
      return;
    }

    let next = null;
    for (let i = 0; i < videos.length; i++) {
      const info = getVideoRowInfo(videos[i], i);
      if (!keptKeys.has(info.key)) {
        next = { video: videos[i], info };
        break;
      }
    }

    if (!next) {
      const loadedMore = await scrollForMoreRows();
      if (loadedMore) {
        idleScrolls = 0;
        continue;
      }

      idleScrolls++;
      dbg('cleanFallbackUI: no new rows after scroll, idleScrolls:', idleScrolls);
      if (idleScrolls >= 3) {
        const remaining = getPlaylistTotal();
        finishCleaning(count, remaining);
        dbg('=== cleanFallbackUI DONE (scan complete) ===', count, 'removed, remaining:', remaining);
        return;
      }
      continue;
    }

    idleScrolls = 0;
    const { video, info } = next;
    video.scrollIntoView({ block: 'center' });
    await sleep(150);

    if (!shouldDeleteVideoByProgress(info.watchedPercent, settings)) {
      traceDecision('fallback-evaluate', {
        action: 'keep',
        reason: 'below-threshold',
        watchedPercent: info.watchedPercent,
        threshold: settings.minProgressPercent,
        videoKey: info.key,
        title: info.title,
      });
      keptKeys.add(info.key);
      dbg('cleanFallbackUI: keeping', info.key, 'watchedPercent:', info.watchedPercent);
      continue;
    }

    traceDecision('fallback-evaluate', {
      action: 'delete',
      reason: 'matched-threshold',
      watchedPercent: info.watchedPercent,
      threshold: settings.minProgressPercent,
      videoKey: info.key,
      title: info.title,
    });

    const removed = await removeVideoViaMenu(
      video,
      info,
      fallbackApiContext.error ? null : fallbackApiContext
    );
    if (removed.ok) {
      count++;
      await reconcileAfterSingleVisibleRemoval();
      traceDecision('fallback-delete-result', {
        action: 'deleted',
        reason: removed.reason || 'menu-click-succeeded',
        watchedPercent: info.watchedPercent,
        threshold: settings.minProgressPercent,
        videoKey: info.key,
        title: info.title,
      });
      dbg('cleanFallbackUI: removed #' + count, 'key:', info.key, 'watchedPercent:', info.watchedPercent);
      sendCount(count);
      window.cleanerState.count = count;
      window.cleanerState.remaining = Math.max(0, getPlaylistTotal());
      updateOverlayProgress(count, totalEstimate);
      await sleep(400);
      continue;
    }

    const attempts = (failedAttempts.get(info.key) || 0) + 1;
    failedAttempts.set(info.key, attempts);
    traceDecision('fallback-delete-result', {
      action: attempts >= 2 ? 'keep' : 'retry',
      reason: attempts >= 2
        ? `menu-click-failed-twice:${removed.reason || 'unknown'}`
        : `menu-click-failed:${removed.reason || 'unknown'}`,
      watchedPercent: info.watchedPercent,
      threshold: settings.minProgressPercent,
      videoKey: info.key,
      title: info.title,
    });
    warn('cleanFallbackUI: failed to remove', info.key, 'attempt', attempts, 'reason:', removed.reason);
    if (attempts >= 2) {
      keptKeys.add(info.key);
    }
    await sleep(400);
  }

  dbg('cleanFallbackUI: stopped at count:', count);
}

// --- Message listener ---

// --- Shared state for popup sync ---

window.cleanerState = createCleanerState();

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dbg('onMessage:', message.command);

  // Synchronous status query — popup asks for current state on open
  if (message.command === 'status') {
    dbg('onMessage: status query, returning state:', JSON.stringify(window.cleanerState));
    sendResponse(window.cleanerState);
    return;
  }

  if (message.command === 'setPopupVisible') {
    window.cleanerState.popupVisible = Boolean(message.visible);
    setOverlayVisible(window.cleanerIsRunning && !window.cleanerState.popupVisible);
    sendResponse({ ok: true });
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

  if (message.command === 'estimate') {
    (async () => {
      try {
        const settings = normalizeSettings(message.settings);
        const result = await estimatePlaylistMatches(settings);
        sendResponse(result);
      } catch (error) {
        warn('estimate failed:', error.message);
        sendResponse({
          ready: false,
          matching: 0,
          total: getPlaylistTotal(),
          source: 'error',
        });
      }
    })();
    return true;
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
      const settings = normalizeSettings(message.settings);
      invalidateEstimateCache();
      sendLog('Starting...', 'success');
      window.cleanerIsRunning = true;
      window.cleanerRefreshAttempts = 0;
      window.cleanerState = createCleanerState({
        running: true,
        done: false,
        count: 0,
        total: getPlaylistTotal(),
        remaining: getPlaylistTotal(),
        matchingEstimate: Math.max(0, Number(message.estimatedMatching) || 0),
        startTime: Date.now(),
        method: null,
        apiFailedAt: null,
        settings,
      });
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
    window.cleanerState.done = false;
    await sleep(1000);
    await cleanAllAPI();
  }

  })(); // end async IIFE
});

dbg('Content script loaded on:', window.location.href);
})();
