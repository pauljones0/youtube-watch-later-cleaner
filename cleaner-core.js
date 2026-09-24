/* Shared, browser-independent cleaning engine. No page-model mutations. */
(() => {
  'use strict';
  // Safe default: only mostly-watched videos are removed unless the user chooses
  // otherwise. 0% (delete everything) is never implicit; it needs confirmation.
  const DEFAULT_THRESHOLD = 90;
  const percent = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const watchedPercent = value => {
    const number = Number(typeof value === 'string' ? value.trim().replace(/%$/, '') : value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  };
  const isWatchLater = value => {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol)
        && ['www.youtube.com', 'youtube.com'].includes(url.hostname)
        && url.pathname === '/playlist' && url.searchParams.get('list') === 'WL';
    } catch (_) { return false; }
  };
  class Failure extends Error {
    constructor(message, code = 'api', status = 0) { super(message); this.code = code; this.status = status; }
  }
  const cancelled = () => new Failure('Stopped.', 'cancelled');
  function check(signal) { if (signal?.aborted) throw cancelled(); }
  function delay(ms, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(cancelled()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  function account(config) {
    const [first = '', second = ''] = String(config?.DATASYNC_ID || '').split('||');
    return { index: String(config?.SESSION_INDEX ?? '0'),
      delegated: config?.DELEGATED_SESSION_ID || (second ? first : ''),
      user: config?.USER_SESSION_ID || second || first };
  }
  function identity(config) {
    return JSON.stringify([account(config), config?.INNERTUBE_CONTEXT?.user?.onBehalfOfUser || '']);
  }
  function walk(value, visit) {
    if (!value || typeof value !== 'object') return;
    visit(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, visit);
  }
  function parsePage(response, continuation = false) {
    if (!response || typeof response !== 'object' || response.error) {
      throw new Failure(response?.error?.message || 'Invalid playlist response.', 'response');
    }
    const alerts = (response.alerts || []).map(a => a.alertRenderer || a.alertWithButtonRenderer).filter(Boolean);
    if (alerts.some(a => a.type === 'ERROR')) throw new Failure('YouTube rejected the playlist request.', 'response');
    let items = null, owner = null;
    const containers = [];
    if (continuation) {
      const actions = [...(response.onResponseReceivedActions || []), ...(response.onResponseReceivedEndpoints || [])];
      for (const action of actions) if (action.appendContinuationItemsAction) containers.push({ owner: action.appendContinuationItemsAction, items: action.appendContinuationItemsAction.continuationItems });
      const list = response.continuationContents?.playlistVideoListContinuation;
      if (list) containers.push({ owner: list, items: list.contents });
    } else {
      walk(response.contents, obj => {
        if (obj.playlistVideoListRenderer) containers.push({ owner: obj.playlistVideoListRenderer, items: obj.playlistVideoListRenderer.contents });
      });
    }
    if (containers.length !== 1) throw new Failure('Ambiguous or missing playlist container.', 'schema');
    ({ items, owner } = containers[0]);
    if (!Array.isArray(items)) throw new Failure('Unrecognized playlist response; empty playlist not confirmed.', 'schema');
    const videos = [], tokens = [];
    if (owner.continuations != null) {
      if (!Array.isArray(owner.continuations)) throw new Failure('Invalid continuation metadata.', 'schema');
      for (const entry of owner.continuations) {
        const token = entry?.nextContinuationData?.continuation;
        if (typeof token !== 'string' || !token) throw new Failure('Unrecognized continuation metadata.', 'schema');
        tokens.push(token);
      }
    }
    for (const item of items) {
      const row = item.playlistVideoRenderer;
      if (row) {
        if (!row.setVideoId) throw new Failure('Playlist entry has no removal ID.', 'schema');
        const resume = row.thumbnailOverlays?.find(o => o.thumbnailOverlayResumePlaybackRenderer)?.thumbnailOverlayResumePlaybackRenderer;
        videos.push({ setVideoId: row.setVideoId, videoId: row.videoId || row.navigationEndpoint?.watchEndpoint?.videoId || null,
          watchedPercent: watchedPercent(resume?.percentDurationWatched ?? resume?.percentDurationWatchedString ?? 0) });
      } else if (item.continuationItemRenderer) {
        const local = [];
        walk(item.continuationItemRenderer, obj => { if (typeof obj.continuationCommand?.token === 'string' && obj.continuationCommand.token) local.push(obj.continuationCommand.token); });
        tokens.push(...local);
        if (!local.length) throw new Failure('Unrecognized continuation token.', 'schema');
      } else {
        // Unknown entries must not silently disappear from a deletion/verification scan.
        throw new Failure('Unrecognized playlist entry.', 'schema');
      }
    }
    if (new Set(tokens).size > 1) throw new Failure('Conflicting continuation tokens.', 'schema');
    return { videos, continuation: tokens[0] || null };
  }
  async function authHeaders(config, cookies, cryptoAPI = globalThis.crypto) {
    const jar = Object.fromEntries(cookies.split(';').map(c => {
      const [name, ...value] = c.trim().split('='); return [name, value.join('=')];
    }));
    const primary = jar.SAPISID || jar['__Secure-3PAPISID'];
    const schemes = [['SAPISIDHASH', primary], ['SAPISID1PHASH', jar['__Secure-1PAPISID']], ['SAPISID3PHASH', jar['__Secure-3PAPISID']]];
    const ts = Math.floor(Date.now() / 1000), parts = [], session = account(config);
    for (const [scheme, cookie] of schemes) {
      if (!cookie) continue;
      const input = `${session.user ? session.user + ' ' : ''}${ts} ${cookie} https://www.youtube.com`;
      const digest = await cryptoAPI.subtle.digest('SHA-1', new TextEncoder().encode(input));
      parts.push(`${scheme} ${ts}_${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}${session.user ? '_u' : ''}`);
    }
    if (!parts.length) throw new Failure('Authentication unavailable.', 'auth');
    const headers = { 'Content-Type': 'application/json', Authorization: parts.join(' '),
      'X-Goog-AuthUser': session.index, 'X-Origin': 'https://www.youtube.com' };
    if (session.delegated) headers['X-Goog-PageId'] = session.delegated;
    if (config.INNERTUBE_CONTEXT_CLIENT_NAME != null) headers['X-YouTube-Client-Name'] = String(config.INNERTUBE_CONTEXT_CLIENT_NAME);
    if (config.INNERTUBE_CONTEXT_CLIENT_VERSION) headers['X-YouTube-Client-Version'] = config.INNERTUBE_CONTEXT_CLIENT_VERSION;
    if (config.VISITOR_DATA) headers['X-Goog-Visitor-Id'] = config.VISITOR_DATA;
    return headers;
  }
  class Cleaner {
    constructor(adapter) {
      this.a = adapter; this.task = null; this.run = null; this.sequence = 0;
      this.state = { documentId: globalThis.crypto.randomUUID(), revision: 0, phase: 'idle', running: false, count: 0, observed: 0, remaining: null, total: null, matching: null, threshold: DEFAULT_THRESHOLD, message: 'Ready.' };
    }
    emit(update) {
      this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
      try { this.a.onState?.({ ...this.state }); } catch (_) { /* Observers cannot interrupt a run. */ }
    }
    log(...args) { try { this.a.log?.(...args); } catch (_) {} }
    guard(run) {
      check(run.controller.signal);
      const currentConfig = run.identity ? this.a.config() : null;
      if (this.run !== run || !isWatchLater(this.a.url()) || (run.identity && (!currentConfig || identity(currentConfig) !== run.identity))) {
        run.controller.abort(); throw new Failure('Stopped: playlist or account changed.', 'cancelled');
      }
    }
    async ready(run) {
      for (let i = 0; i < 30; i++) {
        this.guard(run);
        const cfg = this.a.config();
        if (cfg?.INNERTUBE_CONTEXT && cfg?.INNERTUBE_API_KEY) { run.identity = identity(cfg); return cfg; }
        await delay(500, run.controller.signal);
      }
      throw new Failure('YouTube is still loading. Refresh the Watch Later page and try again.', 'config');
    }
    async request(run, endpoint, body) {
      this.guard(run);
      const cfg = this.a.config();
      const headers = await authHeaders(cfg, this.a.cookies());
      this.guard(run);
      const response = await this.a.request(`/youtubei/v1/${endpoint}?key=${encodeURIComponent(cfg.INNERTUBE_API_KEY)}&prettyPrint=false`,
        headers, { context: cfg.INNERTUBE_CONTEXT, ...body }, run.controller.signal);
      this.guard(run);
      if (!response || response.error) throw new Failure(response?.error?.message || 'Invalid API response.', 'response');
      return response;
    }
    async scan(run) {
      const videos = [], seenIDs = new Set(), seenTokens = new Set(); let token = null;
      for (let page = 0; page < 200; page++) {
        const result = parsePage(await this.request(run, 'browse', token ? { continuation: token } : { browseId: 'VLWL', params: 'wgYCCAA=' }), !!token);
        for (const video of result.videos) {
          if (!seenIDs.has(video.setVideoId)) { seenIDs.add(video.setVideoId); videos.push(video); }
        }
        if (!result.continuation) return videos;
        if (seenTokens.has(result.continuation)) throw new Failure('Playlist pagination repeated; scan incomplete.', 'pagination');
        seenTokens.add(result.continuation); token = result.continuation;
      }
      throw new Failure('Playlist scan limit reached; scan incomplete.', 'pagination');
    }
    async remove(run, batch) {
      let pending = batch;
      for (let attempt = 0; attempt < 2; attempt++) {
        this.guard(run);
        let result, failure;
        try {
          run.mutationPending = true;
          result = await this.request(run, 'browse/edit_playlist', { playlistId: 'WL', params: 'CAFAAQ==',
            actions: pending.map(v => ({ action: 'ACTION_REMOVE_VIDEO', setVideoId: v.setVideoId })) });
          if (result.status !== 'STATUS_SUCCEEDED') throw new Failure('YouTube rejected the batch edit.', 'edit');
          run.mutationPending = false;
          pending.forEach(v => run.removedIds.add(v.setVideoId));
          this.emit({ count: this.state.count + pending.length }); return;
        } catch (error) { failure = error; }
        this.guard(run);
        // A completed scan is the only valid way to infer absent IDs after an uncertain edit.
        const remaining = new Set((await this.scan(run)).map(v => v.setVideoId));
        pending.filter(v => !remaining.has(v.setVideoId)).forEach(v => run.removedIds.add(v.setVideoId));
        const stillPresent = pending.filter(v => remaining.has(v.setVideoId));
        this.emit({ count: this.state.count + pending.length - stillPresent.length });
        pending = stillPresent; run.mutationPending = false;
        if (!pending.length) return;
        if (attempt === 1) throw failure;
        await delay(1000, run.controller.signal);
      }
    }
    async execute(run) {
      await this.ready(run);
      let videos;
      try { videos = await this.scan(run); }
      catch (error) {
        this.guard(run);
        this.log('API scan failed', error.code, error.status, error.message);
        return this.fallback(run);
      }
      const targets = videos.filter(v => v.watchedPercent >= run.threshold);
      this.emit({ total: videos.length, remaining: videos.length, matching: targets.length, phase: 'removing', method: 'api' });
      for (let i = 0; i < targets.length; i += 100) {
        this.guard(run);
        this.emit({ message: `Removing videos… ${this.state.count} removed.` });
        try { await this.remove(run, targets.slice(i, i + 100)); }
        catch (error) {
          this.guard(run);
          // If verification itself failed, don't combine an unresolved edit with UI clicks.
          if (run.mutationPending) throw new Failure('Could not verify the last edit. Refresh before running again.', 'uncertain');
          this.log('Batch failed; UI fallback', error.code, error.message);
          return this.fallback(run, new Set(targets.slice(i).map(v => v.setVideoId).filter(id => !run.removedIds.has(id))));
        }
        await delay(350, run.controller.signal);
      }
      this.emit({ phase: 'verifying', message: 'Verifying the remaining playlist…' });
      const remaining = await this.scan(run);
      const selected = new Set(targets.map(v => v.setVideoId));
      const matching = remaining.filter(v => selected.has(v.setVideoId) || v.watchedPercent >= run.threshold).length;
      if (matching) throw new Failure(`${matching} matching videos remain. Run again to retry.`, 'partial');
      this.emit({ phase: 'done', remaining: remaining.length, message: `Done. Removed ${this.state.count}; ${remaining.length} kept.` });
    }
    async fallback(run, selectedIds = null) {
      this.guard(run);
      this.emit({ phase: 'fallback', method: 'ui', message: 'API unavailable. Using page controls; changes will be verified if possible.' });
      if (!this.a.fallback) throw new Failure('Page removal is unavailable.', 'fallback');
      const outcome = await this.a.fallback({ signal: run.controller.signal, threshold: run.threshold, selectedIds,
        onMutation: () => { this.guard(run); run.mutationPending = true; },
        guard: () => this.guard(run), onRemoved: () => this.emit({ observed: this.state.observed + 1 }) });
      this.guard(run);
      try {
        const remaining = await this.scan(run);
        const matching = remaining.filter(v => selectedIds?.has(v.setVideoId) || v.watchedPercent >= run.threshold).length;
        run.mutationPending = false;
        this.emit({ remaining: remaining.length });
        if (!matching) {
          this.emit({ phase: 'done', message: `Verified: no matching videos remain. ${remaining.length} kept.` }); return;
        }
      } catch (error) { this.guard(run); this.log('UI verification unavailable', error.message); }
      throw new Failure(`Page removal stopped: ${this.state.observed} rows removed, ${outcome.failed || 0} failed. Refresh to verify and retry.`, 'partial');
    }
    start(threshold = DEFAULT_THRESHOLD, options = {}) {
      if (this.task) return { accepted: false, message: 'The previous run is still stopping.', state: this.state };
      if (!isWatchLater(this.a.url())) return { accepted: false, message: 'Open your Watch Later playlist first.', state: this.state };
      const normalized = percent(threshold);
      if (normalized === 0 && !options?.confirmDeleteAll) {
        return { accepted: false, message: 'Removing everything requires confirmation. Pick a watched percentage above 0% or confirm deletion of the entire list.', state: this.state };
      }
      const run = { id: ++this.sequence, threshold: normalized, controller: new AbortController(), identity: null, mutationPending: false, removedIds: new Set() };
      this.run = run;
      this.emit({ runId: run.id, phase: 'scanning', running: true, count: 0, observed: 0, total: null, remaining: null,
        matching: null, threshold: run.threshold, startedAt: Date.now(), finishedAt: null, message: 'Scanning the playlist…', method: 'api', uncertain: false });
      // Schedule after task is assigned, so synchronous adapter failures cannot leave a stale task.
      this.task = Promise.resolve().then(() => this.execute(run)).catch(error => {
        const stopped = run.controller.signal.aborted || error.code === 'cancelled';
        this.log('Run ended', error.code, error.message);
        this.emit({ phase: stopped ? 'stopped' : 'error', uncertain: run.mutationPending,
          message: stopped ? `Stopped.${run.mutationPending ? ' An in-flight edit may have completed; refresh to verify.' : ''}` : error.message });
      }).finally(() => { this.emit({ running: false, finishedAt: Date.now() }); this.task = null; });
      return { accepted: true, state: { ...this.state } };
    }
    async stop() {
      if (this.task) {
        this.emit({ phase: 'stopping', message: 'Stopping…' }); this.run.controller.abort();
        await this.task;
      }
      return { accepted: true, state: { ...this.state } };
    }
  }
  const exports = { Cleaner, Failure, DEFAULT_THRESHOLD, percent, watchedPercent, isWatchLater, identity, parsePage, authHeaders, delay, check };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  else globalThis.WLCCore = exports;
})();
