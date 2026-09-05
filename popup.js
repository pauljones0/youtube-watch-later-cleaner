document.addEventListener('DOMContentLoaded', async () => {
  'use strict';
  const C = globalThis.WLCCore, $ = id => document.getElementById(id);
  const action = $('actionButton'), status = $('status');
  let tab = null, state = null, mode = 'loading', busy = false, sequence = 0, previewSequence = 0, previewTimer;
  let eventVersion = 0, commandEpoch = 0, settingsWarning = false;
  let settings = { sliderThreshold: 0, advancedOpen: false };
  const setStatus = (text, kind = '') => { status.textContent = text; status.className = `status-bar ${kind}`; };
  function settingsUI() {
    $('progressThreshold').value = settings.sliderThreshold;
    $('progressThresholdValue').textContent = `${settings.sliderThreshold}%`;
    $('advancedPanel').classList.toggle('hidden', !settings.advancedOpen);
    $('advancedToggle').classList.toggle('expanded', settings.advancedOpen);
    $('advancedToggle').setAttribute('aria-expanded', String(settings.advancedOpen));
    $('advancedHelp').textContent = settings.sliderThreshold > 0
      ? `Only videos watched at least ${settings.sliderThreshold}% will be removed, even when this panel is closed.`
      : 'All videos will be removed. Increase the percentage to keep unwatched videos.';
  }
  function render(next) {
    state = next;
    mode = next.running ? 'stop' : 'start';
    action.classList.remove('hidden'); action.className = next.running ? 'state-stop' : 'state-start';
    action.textContent = next.running ? (next.phase === 'stopping' ? 'Stopping…' : 'Stop') : 'Start Cleaning';
    action.disabled = busy || next.phase === 'stopping';
    $('progressThreshold').disabled = next.running;
    $('emptyState').classList.toggle('hidden', !(next.phase === 'done' && next.remaining === 0));
    const showCount = next.runId != null;
    $('progress').classList.toggle('hidden', !showCount);
    $('count').textContent = (next.count || 0).toLocaleString();
    $('progressLabel').textContent = 'API removals';
    $('totalLabel').textContent = next.observed ? `${next.observed.toLocaleString()} UI rows removed` : next.matching != null ? `of ${next.matching.toLocaleString()} matching` : '';
    $('progressBar').style.width = next.matching > 0 ? `${Math.min(100, next.count / next.matching * 100)}%` : '0%';
    $('eta').textContent = next.observed ? 'UI changes are verified before reporting completion.' : '';
    const kind = next.phase === 'error' ? 'error' : ['stopped', 'stopping'].includes(next.phase) ? 'warning' : 'success';
    setStatus(next.runId ? next.message : `Ready. ${settings.sliderThreshold ? `Remove videos watched at least ${settings.sliderThreshold}%.` : 'Remove all Watch Later videos.'}`, kind);
    if (!next.runId && settingsWarning) setStatus('Saved filter could not be loaded. Check the percentage before starting.', 'warning');
    if (next.phase === 'done') $('reviewLink').classList.add('highlight');
    $('refreshButton').hidden = next.running || !next.runId;
  }
  function accept(next) {
    if (!next) return false;
    if (state && state.documentId === next.documentId && ((next.revision ?? 0) < (state.revision ?? 0) || (next.runId ?? 0) < (state.runId ?? 0))) return false;
    render(next); return true;
  }
  async function ensure(target) {
    try { return await browser.tabs.sendMessage(target.id, { command: 'status' }); }
    catch (error) {
      if (!/receiving end|establish connection|matching message handler/i.test(String(error.message))) throw error;
      await browser.tabs.executeScript(target.id, { file: 'cleaner-core.js' });
      await browser.tabs.executeScript(target.id, { file: 'content.js' });
      return browser.tabs.sendMessage(target.id, { command: 'status' });
    }
  }
  async function refresh() {
    const seq = ++sequence;
    ++commandEpoch; busy = false; mode = 'loading'; action.disabled = true;
    ++previewSequence; clearTimeout(previewTimer);
    try {
      const [current] = await browser.tabs.query({ active: true, currentWindow: true });
      if (seq !== sequence) return;
      if (tab?.id !== current?.id) state = null;
      tab = current; mode = 'loading'; action.disabled = true;
      if (!tab || !C.isWatchLater(tab.url)) {
        mode = 'nav'; state = null;
        action.className = 'state-nav'; action.textContent = 'Go to Watch Later'; action.disabled = !tab;
        $('progress').classList.add('hidden'); $('emptyState').classList.add('hidden'); $('refreshButton').hidden = true;
        setStatus('Open your Watch Later playlist.', 'warning'); return;
      }
      const target = tab, version = eventVersion, result = await ensure(target);
      if (seq !== sequence || target.id !== tab?.id) return;
      if (version === eventVersion) accept(result);
      browser.tabs.sendMessage(tab.id, { command: 'setPopupVisible', visible: true }).catch(() => {});
      if (!state?.running) preview();
    } catch (error) {
      if (seq !== sequence) return;
      mode = 'retry'; action.disabled = false; action.textContent = 'Retry connection';
      setStatus(`Could not connect to YouTube: ${error.message}`, 'error');
    }
  }
  function preview() {
    const requestID = ++previewSequence; clearTimeout(previewTimer);
    if (!tab || !C.isWatchLater(tab.url) || state?.running) return;
    const target = tab, threshold = settings.sliderThreshold;
    $('advancedHelp').textContent = 'Checking the playlist… Your filter stays active when Advanced is closed.';
    previewTimer = setTimeout(async () => {
      try {
        const result = await browser.tabs.sendMessage(target.id, { command: 'estimate', threshold });
        if (requestID !== previewSequence || target.id !== tab?.id || state?.running) return;
        $('advancedHelp').textContent = `${result.matching.toLocaleString()} of ${result.total.toLocaleString()} videos currently match. The playlist is scanned again when you start.`;
      } catch (_) { if (requestID === previewSequence) settingsUI(); }
    }, 250);
  }
  function saveSettings() { browser.storage.local.set({ cleanerSettings: settings }).catch(error => setStatus(`Could not save settings: ${error.message}`, 'warning')); }
  $('advancedToggle').addEventListener('click', () => { settings.advancedOpen = !settings.advancedOpen; settingsUI(); saveSettings(); });
  $('progressThreshold').addEventListener('input', () => { settings.sliderThreshold = C.percent($('progressThreshold').value); settingsUI(); preview(); });
  $('progressThreshold').addEventListener('change', saveSettings);
  action.addEventListener('click', async () => {
    if (busy || !tab) return;
    if (mode === 'nav') { await browser.tabs.update(tab.id, { url: 'https://www.youtube.com/playlist?list=WL' }); return; }
    if (mode === 'retry') { refresh(); return; }
    if (!['start', 'stop'].includes(mode)) return;
    busy = true; action.disabled = true; ++previewSequence; clearTimeout(previewTimer);
    const target = tab, command = mode, seq = sequence, epoch = ++commandEpoch;
    try {
      const response = await browser.tabs.sendMessage(target.id, { command, threshold: settings.sliderThreshold });
      if (seq !== sequence || target.id !== tab?.id) return;
      busy = false;
      if (!response?.accepted) {
        if (response?.state) accept(response.state);
        setStatus(response?.message || 'The command was not accepted.', 'error'); return;
      }
      // Obtain current state: Start may have completed or failed since its acknowledgment.
      const version = eventVersion;
      const result = await browser.tabs.sendMessage(target.id, { command: 'status' });
      if (seq === sequence && target.id === tab?.id && version === eventVersion) accept(result);
    } catch (error) { if (seq === sequence) { busy = false; action.disabled = false; setStatus(error.message, 'error'); } }
    finally { if (epoch === commandEpoch) { busy = false; if (state?.phase !== 'stopping') action.disabled = false; } }
  });
  $('refreshButton').addEventListener('click', async () => { if (tab && !state?.running) await browser.tabs.reload(tab.id); });
  $('reviewLink').addEventListener('click', event => { event.preventDefault(); browser.tabs.create({ url: 'https://addons.mozilla.org/firefox/addon/youtube-watch-later-cleaner/' }); });
  $('bugReport').addEventListener('click', async () => {
    try {
      let report;
      try { report = tab && await browser.tabs.sendMessage(tab.id, { command: 'getLogs' }); } catch (_) {}
      report ||= (await browser.storage.local.get('cleanerLastRun')).cleanerLastRun;
      const text = JSON.stringify({ extension: browser.runtime.getManifest().version, browser: navigator.userAgent, report: report || 'No run recorded.' }, null, 2);
      await navigator.clipboard.writeText(text);
      // User can review/copy diagnostics and choose to send them; no message is sent automatically.
      const a = document.createElement('a');
      a.href = `mailto:ytwl@pauljones0.uk?subject=${encodeURIComponent('Watch Later Cleaner bug report')}&body=${encodeURIComponent('What happened?\n\nPaste the copied diagnostics below:\n\n')}`;
      a.click(); setStatus('Diagnostics copied. Paste them into your bug report.', 'success');
    } catch (error) { setStatus(`Could not copy diagnostics: ${error.message}`, 'error'); }
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    if (message.type !== 'state' || sender.tab?.id !== tab?.id || !C.isWatchLater(tab?.url)) return;
    if (state?.documentId && message.state.documentId !== state.documentId) { refresh(); return; }
    if (accept(message.state)) ++eventVersion;
  });
  browser.tabs.onUpdated.addListener((id, change) => { if (id === tab?.id && (change.url || change.status === 'loading' || change.status === 'complete')) refresh(); });
  browser.tabs.onActivated.addListener(refresh);
  window.addEventListener('pagehide', () => {
    clearTimeout(previewTimer);
    if (tab) browser.tabs.sendMessage(tab.id, { command: 'setPopupVisible', visible: false }).catch(() => {});
  });
  try {
    const stored = (await browser.storage.local.get('cleanerSettings')).cleanerSettings;
    settings = { sliderThreshold: C.percent(stored?.sliderThreshold), advancedOpen: !!stored?.advancedOpen };
  } catch (_) { settingsWarning = true; }
  settingsUI(); await refresh();
});
