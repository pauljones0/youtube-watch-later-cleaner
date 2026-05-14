document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);

  const actionButton = $('actionButton');
  const statusDiv = $('status');
  const progressSection = $('progress');
  const countSpan = $('count');
  const progressLabel = $('progressLabel');
  const totalLabel = $('totalLabel');
  const progressBar = $('progressBar');
  const etaDiv = $('eta');
  const reviewLink = $('reviewLink');
  const emptyState = $('emptyState');
  const bugReport = $('bugReport');
  const advancedToggle = $('advancedToggle');
  const advancedPanel = $('advancedPanel');
  const progressThreshold = $('progressThreshold');
  const progressThresholdValue = $('progressThresholdValue');
  const advancedHelp = $('advancedHelp');

  const SETTINGS_KEY = 'cleanerSettings';
  const PREVIEW_CACHE_KEY = 'cleanerPreviewHistogram';
  const PREVIEW_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
  const DEFAULT_UI_STATE = Object.freeze({
    sliderThreshold: 0,
    advancedOpen: false,
  });

  const WATCH_LATER_URL_FRAGMENT = 'youtube.com/playlist?list=WL';

  let currentTab = null;
  let currentTabState = null;
  let buttonState = 'start';
  let totalVideos = 0;
  let startTime = null;
  let currentUIState = { ...DEFAULT_UI_STATE };
  let previewCache = null;
  let previewState = {
    ready: false,
    threshold: 0,
    matching: 0,
    total: 0,
  };
  let lastIdleRender = {
    countText: '0',
    totalText: '',
    percent: 0,
  };
  let estimateRequestSeq = 0;
  let estimateDebounceTimer = null;
  let contentScriptReadyTabId = null;
  let contentScriptReadyPromise = null;

  const isWatchLaterUrl = url => typeof url === 'string' && url.includes(WATCH_LATER_URL_FRAGMENT);

  const clampThreshold = value => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  };

  const normalizeUIState = state => ({
    sliderThreshold: clampThreshold(state?.sliderThreshold),
    advancedOpen: Boolean(state?.advancedOpen),
  });

  const effectiveSettings = (uiState = currentUIState) => ({
    minProgressPercent: uiState.advancedOpen ? uiState.sliderThreshold : 0,
  });

  const hasFreshPreviewCache = () => (
    previewCache
    && Array.isArray(previewCache.countsAtLeast)
    && previewCache.countsAtLeast.length === 101
    && (Date.now() - previewCache.savedAt) <= PREVIEW_CACHE_MAX_AGE_MS
  );

  const syncKnownTotalFromCache = () => {
    if (totalVideos > 0) return totalVideos;
    if (hasFreshPreviewCache() && previewCache.total > 0) {
      totalVideos = previewCache.total;
    }
    return totalVideos;
  };

  const getPreviewCacheCount = threshold => {
    if (!hasFreshPreviewCache()) return null;
    if (previewCache.total > 0 && totalVideos > 0 && previewCache.total !== totalVideos) return null;
    const idx = clampThreshold(threshold);
    return typeof previewCache.countsAtLeast[idx] === 'number' ? previewCache.countsAtLeast[idx] : null;
  };

  const savePreviewCacheEntry = (countsAtLeast, total) => {
    previewCache = {
      countsAtLeast,
      total,
      savedAt: Date.now(),
    };
    browser.storage.local.set({ [PREVIEW_CACHE_KEY]: previewCache }).catch(() => {});
  };

  const saveUIState = () => {
    browser.storage.local.set({ [SETTINGS_KEY]: currentUIState }).catch(() => {});
  };

  const syncPopupVisibility = visible => {
    if (!currentTab?.id || !isWatchLaterUrl(currentTab.url)) return;
    browser.tabs.sendMessage(currentTab.id, {
      command: 'setPopupVisible',
      visible,
    }).catch(() => {});
  };

  const setStatus = (text, cls = '') => {
    statusDiv.textContent = text;
    statusDiv.className = 'status-bar ' + cls;
  };

  const isMissingContentScriptError = error => {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('could not establish connection')
      || message.includes('receiving end does not exist')
      || message.includes('no matching message handler');
  };

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const pingContentScript = tabId => browser.tabs.sendMessage(tabId, { command: 'status' });

  const ensureContentScript = async tab => {
    if (!tab?.id || !isWatchLaterUrl(tab.url)) return null;

    if (contentScriptReadyPromise && contentScriptReadyTabId === tab.id) {
      return contentScriptReadyPromise;
    }

    contentScriptReadyTabId = tab.id;
    contentScriptReadyPromise = (async () => {
      try {
        return await pingContentScript(tab.id);
      } catch (error) {
        if (!isMissingContentScriptError(error)) throw error;
      }

      try {
        await browser.tabs.executeScript(tab.id, { file: 'content.js' });
      } catch (error) {
        await delay(100);
        try {
          return await pingContentScript(tab.id);
        } catch (_) {
          throw error;
        }
      }

      return pingContentScript(tab.id);
    })().finally(() => {
      if (contentScriptReadyTabId === tab.id) {
        contentScriptReadyTabId = null;
        contentScriptReadyPromise = null;
      }
    });

    return contentScriptReadyPromise;
  };

  const contentScriptFailureMessage = error => {
    const message = String(error?.message || error || '');
    if (/permission|access/i.test(message)) {
      return 'YouTube tab access was blocked. Refresh the Watch Later tab and try again.';
    }
    return 'Could not connect to this YouTube tab. Refresh it and try again.';
  };

  const setButtonState = state => {
    buttonState = state;
    actionButton.className = '';
    actionButton.disabled = false;

    if (state === 'nav') {
      actionButton.classList.add('state-nav');
      actionButton.textContent = 'Go to Watch Later';
    } else if (state === 'start') {
      actionButton.classList.add('state-start');
      actionButton.textContent = 'Start Cleaning';
    } else if (state === 'stop') {
      actionButton.classList.add('state-stop');
      actionButton.textContent = 'Stop';
    } else if (state === 'done') {
      actionButton.classList.add('state-start');
      actionButton.textContent = 'Run Again';
    }
  };

  const setAdvancedOpen = open => {
    currentUIState.advancedOpen = open;
    advancedToggle.classList.toggle('expanded', open);
    advancedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    advancedPanel.classList.toggle('hidden', !open);
  };

  const syncSettingsUI = () => {
    progressThreshold.value = currentUIState.sliderThreshold;
    progressThresholdValue.textContent = `${currentUIState.sliderThreshold}%`;
    advancedHelp.textContent = '';
    setAdvancedOpen(currentUIState.advancedOpen);
  };

  const setProgressWidth = ratio => {
    const pct = Math.max(0, Math.min(100, ratio));
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = `${pct}%`;
  };

  const renderIdlePreview = ({ preserveKnownCount = false } = {}) => {
    syncKnownTotalFromCache();

    if (totalVideos <= 0) {
      progressSection.classList.add('hidden');
      return;
    }

    progressSection.classList.remove('hidden');
    progressLabel.textContent = 'to delete';

    const settings = effectiveSettings();
    if (settings.minProgressPercent === 0) {
      countSpan.textContent = totalVideos.toLocaleString();
      totalLabel.textContent = `of ~${totalVideos.toLocaleString()}`;
      etaDiv.textContent = '';
      setProgressWidth(100);
      lastIdleRender = {
        countText: countSpan.textContent,
        totalText: totalLabel.textContent,
        percent: 100,
      };
      return;
    }

    const cachedCount = getPreviewCacheCount(settings.minProgressPercent);
    if (cachedCount != null) {
      countSpan.textContent = cachedCount.toLocaleString();
      totalLabel.textContent = `of ~${totalVideos.toLocaleString()}`;
      etaDiv.textContent = '';
      setProgressWidth(totalVideos > 0 ? (cachedCount / totalVideos) * 100 : 0);
      lastIdleRender = {
        countText: countSpan.textContent,
        totalText: totalLabel.textContent,
        percent: totalVideos > 0 ? (cachedCount / totalVideos) * 100 : 0,
      };
      return;
    }

    if (!preserveKnownCount) {
      countSpan.textContent = lastIdleRender.countText || totalVideos.toLocaleString();
      totalLabel.textContent = lastIdleRender.totalText || `of ~${totalVideos.toLocaleString()}`;
      setProgressWidth(lastIdleRender.percent || 0);
    }
    etaDiv.textContent = '';
  };

  const formatDuration = sec => {
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const renderRunning = state => {
    progressSection.classList.remove('hidden');
    progressLabel.textContent = 'removed';
    countSpan.textContent = state.count.toLocaleString();

    const effectiveTotal = state.matchingEstimate > 0 ? state.matchingEstimate : (state.total || totalVideos);
    totalLabel.textContent = effectiveTotal > 0 ? `of ~${effectiveTotal.toLocaleString()}` : '';
    setProgressWidth(effectiveTotal > 0 ? (state.count / effectiveTotal) * 100 : 0);

    if (startTime && state.count > 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = state.count / elapsed;
      if (rate > 0 && effectiveTotal > state.count) {
        etaDiv.textContent = `~${formatDuration((effectiveTotal - state.count) / rate)} remaining`;
      } else {
        etaDiv.textContent = `${rate.toFixed(1)}/s`;
      }
    } else {
      etaDiv.textContent = '';
    }
  };

  const renderDone = state => {
    progressSection.classList.toggle('hidden', state.remaining === 0);
    progressLabel.textContent = 'removed';
    countSpan.textContent = state.count.toLocaleString();
    totalLabel.textContent = state.remaining > 0 ? `${state.remaining.toLocaleString()} kept` : '';
    etaDiv.textContent = '';
    setProgressWidth(100);
  };

  const doneMessage = (count, remaining = 0) => (
    remaining > 0
      ? `Done! Removed ${count.toLocaleString()} videos and kept ${remaining.toLocaleString()}.`
      : `Done! Removed ${count.toLocaleString()} videos.`
  );

  const highlightReviewLink = () => {
    reviewLink.classList.add('highlight');
  };

  reviewLink.addEventListener('click', e => {
    e.preventDefault();
    browser.tabs.create({ url: 'https://addons.mozilla.org/firefox/addon/youtube-watch-later-cleaner/' });
  });

  const queueEstimateRefresh = (immediate = false) => {
    if (!currentTab || !isWatchLaterUrl(currentTab.url)) return;
    if (buttonState === 'stop' || currentTabState?.running) return;

    const settings = effectiveSettings();
    const cacheReadyForTotal = hasFreshPreviewCache()
      && (!totalVideos || !previewCache?.total || previewCache.total === totalVideos);
    renderIdlePreview({ preserveKnownCount: true });

    if (settings.minProgressPercent === 0 || (cacheReadyForTotal && getPreviewCacheCount(settings.minProgressPercent) != null)) {
      return;
    }

    if (estimateDebounceTimer) clearTimeout(estimateDebounceTimer);
    const run = async () => {
      const requestId = ++estimateRequestSeq;
      const tab = currentTab;
      try {
        await ensureContentScript(tab);
        if (requestId !== estimateRequestSeq || tab?.id !== currentTab?.id) return;

        const result = await browser.tabs.sendMessage(tab.id, {
          command: 'estimate',
          settings,
        });
        if (requestId !== estimateRequestSeq) return;
        if (!result?.ready) return;

        totalVideos = result.total || totalVideos;
        if (Array.isArray(result.countsAtLeast) && result.countsAtLeast.length === 101) {
          savePreviewCacheEntry(result.countsAtLeast, result.total || totalVideos);
        }
        previewState = { ready: true, threshold: settings.minProgressPercent, matching: result.matching, total: result.total || totalVideos };
        renderIdlePreview();
      } catch (_) {}
    };

    if (immediate) run();
    else estimateDebounceTimer = setTimeout(run, 180);
  };

  bugReport.addEventListener('click', async () => {
    let logs = [];
    let state = {};
    let sysInfo = {};

    if (currentTab) {
      try {
        const result = await browser.tabs.sendMessage(currentTab.id, { command: 'getLogs' });
        logs = result.logs || [];
        state = result.state || {};
        sysInfo = { url: result.url, ua: result.ua };
      } catch (_) {}
    }

    const version = browser.runtime.getManifest().version;
    const logLines = logs.map(l => {
      const ts = new Date(l.t).toISOString().substr(11, 12);
      return `[${ts}] ${l.l} ${l.m}`;
    }).join('\n');

    const clipText = logLines || '(no logs captured)';
    try {
      await navigator.clipboard.writeText(clipText);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = clipText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }

    let method = state.method || 'unknown';
    if (state.method === 'fallback' && state.apiFailedAt > 0) {
      method = `API then fallback (switched at video #${state.apiFailedAt})`;
    } else if (state.method === 'fallback') {
      method = 'Fallback';
    } else if (state.method === 'api') {
      method = 'API';
    }

    let duration = 'N/A';
    if (state.startTime) {
      const sec = Math.round((Date.now() - state.startTime) / 1000);
      duration = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
    }

    const subject = `Bug Report — Watch Later Cleaner v${version}`;
    const body = [
      'WHAT HAPPENED?',
      '----------------------------------------',
      '(Replace this with a description of what you experienced)',
      '',
      '',
      '',
      'SYSTEM INFO',
      '----------------------------------------',
      `Extension: v${version}`,
      `Method: ${method}`,
      `Threshold: >= ${state.settings?.minProgressPercent || 0}% watched`,
      `Videos removed: ${state.count || 0}`,
      `Videos kept: ${state.remaining || 0}`,
      `Playlist size: ~${state.total || 'unknown'}`,
      `Duration: ${duration}`,
      `Browser: ${sysInfo.ua || navigator.userAgent}`,
      '',
      '',
      'CONSOLE LOGS',
      '----------------------------------------',
      'Full logs were copied to your clipboard.',
      'Paste them here (Ctrl+V / Cmd+V):',
      '',
      '',
    ].join('\n');

    const mailto = `mailto:ytwl@pauljones0.uk?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    const a = document.createElement('a');
    a.href = mailto;
    a.click();

    setStatus('Logs copied — opening email...', 'success');
  });

  advancedToggle.addEventListener('click', () => {
    setAdvancedOpen(!currentUIState.advancedOpen);
    saveUIState();
    if (!currentTabState?.running) {
      renderIdlePreview({ preserveKnownCount: true });
      if (currentUIState.advancedOpen) {
        queueEstimateRefresh(true);
      }
      setStatus('Ready — click Start to begin.', 'success');
    }
  });

  progressThreshold.addEventListener('input', () => {
    currentUIState.sliderThreshold = clampThreshold(progressThreshold.value);
    progressThresholdValue.textContent = `${currentUIState.sliderThreshold}%`;

    if (buttonState !== 'stop' && currentUIState.advancedOpen) {
      renderIdlePreview({ preserveKnownCount: true });
      queueEstimateRefresh();
      setStatus('Ready — click Start to begin.', 'success');
    }
  });

  progressThreshold.addEventListener('change', () => {
    saveUIState();
    if (buttonState !== 'stop' && currentUIState.advancedOpen) {
      queueEstimateRefresh(true);
    }
  });

  const updateInterface = async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return;
    currentTab = tabs[0];
    currentTabState = null;

    const isWL = isWatchLaterUrl(currentTab.url);
    if (!isWL) {
      emptyState.classList.add('hidden');
      progressSection.classList.add('hidden');
      actionButton.classList.remove('hidden');
      setButtonState('nav');
      setStatus('Navigate to your Watch Later playlist.', 'warning');
      return;
    }

    syncKnownTotalFromCache();
    if (totalVideos > 0) {
      emptyState.classList.add('hidden');
      actionButton.classList.remove('hidden');
      setButtonState('start');
      renderIdlePreview({ preserveKnownCount: true });
      setStatus('Ready — click Start to begin.', 'success');
    }

    const [playlistResult, statusResult] = await Promise.allSettled([
      browser.tabs.executeScript(currentTab.id, {
        code: `(() => {
          const el = document.querySelector('ytd-playlist-byline-renderer yt-formatted-string.byline-item');
          if (el) {
            const text = el.textContent.trim();
            const m = text.replace(/,/g, '').match(/(\\d+)/);
            if (m) return parseInt(m[1], 10);
            if (/no video/i.test(text)) return 0;
          }
          const empty = document.querySelector('ytd-playlist-video-list-renderer [id="empty-message"]')
            || document.querySelector('.empty-message');
          if (empty) return 0;
          const header = document.querySelector('ytd-playlist-header-renderer');
          const videos = document.querySelector('ytd-playlist-video-renderer');
          if (header && !videos) return 0;
          return null;
        })()`,
      }),
      ensureContentScript(currentTab),
    ]);

    let playlistCount = null;
    if (playlistResult.status === 'fulfilled') {
      playlistCount = playlistResult.value?.[0] ?? null;
    }

    if (statusResult.status === 'fulfilled') {
      currentTabState = statusResult.value;
      syncPopupVisibility(true);
    }

    if (currentTabState?.running) {
      emptyState.classList.add('hidden');
      actionButton.classList.remove('hidden');
      totalVideos = currentTabState.total > 0 ? currentTabState.total : totalVideos;
      startTime = currentTabState.startTime;
      setButtonState('stop');
      renderRunning(currentTabState);
      setStatus(
        currentTabState.settings?.minProgressPercent > 0
          ? `Deleting videos >= ${currentTabState.settings.minProgressPercent}% watched...`
          : 'Cleaning in progress...',
        'success'
      );
      return;
    }

    if (statusResult.status === 'rejected') {
      emptyState.classList.add('hidden');
      progressSection.classList.add('hidden');
      actionButton.classList.add('hidden');
      setStatus(contentScriptFailureMessage(statusResult.reason), 'error');
      return;
    }

    const recentlyCompleted = currentTabState?.done && currentTabState?.completedAt
      && (Date.now() - currentTabState.completedAt < 8000);

    if (recentlyCompleted && currentTabState.count > 0) {
      totalVideos = currentTabState.total > 0 ? currentTabState.total : totalVideos;
      setButtonState('done');
      renderDone(currentTabState);
      setStatus(doneMessage(currentTabState.count, currentTabState.remaining || 0), 'success');
      if ((currentTabState.remaining || 0) === 0) {
        emptyState.classList.remove('hidden');
        actionButton.classList.add('hidden');
      } else {
        emptyState.classList.add('hidden');
        actionButton.classList.remove('hidden');
      }
      highlightReviewLink();
      return;
    }

    if (playlistCount === 0) {
      emptyState.classList.remove('hidden');
      progressSection.classList.add('hidden');
      actionButton.classList.add('hidden');
      setStatus('Nothing to clean!', 'success');
      return;
    }

    if (playlistCount === null) {
      emptyState.classList.add('hidden');
      progressSection.classList.add('hidden');
      actionButton.classList.add('hidden');
      setStatus('Loading...', 'success');
      setTimeout(updateInterface, 1500);
      return;
    }

    totalVideos = playlistCount;
    startTime = null;
    emptyState.classList.add('hidden');
    actionButton.classList.remove('hidden');
    setButtonState('start');
    renderIdlePreview({ preserveKnownCount: true });
    setStatus('Ready — click Start to begin.', 'success');
    queueEstimateRefresh(true);
  };

  const stored = await browser.storage.local.get([SETTINGS_KEY, PREVIEW_CACHE_KEY]);
  currentUIState = normalizeUIState(stored[SETTINGS_KEY]);
  previewCache = stored[PREVIEW_CACHE_KEY] && typeof stored[PREVIEW_CACHE_KEY] === 'object'
    ? stored[PREVIEW_CACHE_KEY]
    : null;
  syncSettingsUI();
  syncKnownTotalFromCache();
  renderIdlePreview({ preserveKnownCount: true });
  setStatus('Ready — click Start to begin.', 'success');
  updateInterface();

  let popupVisibilityCleared = false;
  const clearPopupVisibility = () => {
    if (popupVisibilityCleared) return;
    popupVisibilityCleared = true;
    syncPopupVisibility(false);
  };

  window.addEventListener('pagehide', clearPopupVisibility);
  window.addEventListener('unload', clearPopupVisibility);

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!currentTab || tabId !== currentTab.id) return;
    if (changeInfo.url || changeInfo.status === 'complete') updateInterface();
  });

  actionButton.addEventListener('click', async () => {
    if (buttonState === 'nav') {
      setStatus('Navigating...', 'success');
      actionButton.disabled = true;
      browser.tabs.update(currentTab.id, { url: 'https://www.youtube.com/playlist?list=WL' }).then(() => {
        browser.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === currentTab.id && info.status === 'complete') {
            browser.tabs.onUpdated.removeListener(listener);
            setTimeout(updateInterface, 1500);
          }
        });
      });
      return;
    }

    if (buttonState === 'start' || buttonState === 'done') {
      const settings = effectiveSettings();
      const cachedMatching = getPreviewCacheCount(settings.minProgressPercent);
      const estimatedMatching = settings.minProgressPercent === 0
        ? totalVideos
        : (cachedMatching ?? (previewState.ready && previewState.threshold === settings.minProgressPercent ? previewState.matching : 0));

      actionButton.disabled = true;
      setStatus('Preparing YouTube tab...', 'success');

      const tab = currentTab;
      try {
        await ensureContentScript(tab);
        await browser.tabs.sendMessage(tab.id, {
          command: 'start',
          settings,
          estimatedMatching,
        });
      } catch (error) {
        setButtonState('start');
        renderIdlePreview();
        setStatus(contentScriptFailureMessage(error), 'error');
        return;
      }

      startTime = Date.now();
      setButtonState('stop');
      renderRunning({
        count: 0,
        total: totalVideos,
        matchingEstimate: estimatedMatching,
      });
      setStatus(
        settings.minProgressPercent > 0
          ? `Deleting videos >= ${settings.minProgressPercent}% watched...`
          : 'Cleaning in progress...',
        'success'
      );
      return;
    }

    if (buttonState === 'stop') {
      browser.tabs.sendMessage(currentTab.id, { command: 'stop' });
      setStatus('Stopping...', 'warning');
      actionButton.disabled = true;
    }
  });

  browser.runtime.onMessage.addListener(message => {
    if (message.type === 'log') {
      if (message.text.includes('Removing')) {
        setStatus(message.text, 'success');
      } else if (/^\d+ removed/.test(message.text)) {
        setStatus('Cleaning in progress...', 'success');
      } else {
        setStatus(message.text, message.class);
      }
      return;
    }

    if (message.type === 'count') {
      renderRunning({
        count: message.count,
        total: totalVideos,
        matchingEstimate: currentTabState?.matchingEstimate || previewState.matching || totalVideos,
      });
      return;
    }

    if (message.type === 'error') {
      setStatus(message.text, 'error');
      setButtonState(message.text.includes('sign in') || message.text.includes('Sign in') ? 'nav' : 'start');
      renderIdlePreview();
      return;
    }

    if (message.type === 'complete') {
      previewCache = null;
      browser.storage.local.remove(PREVIEW_CACHE_KEY).catch(() => {});
      renderDone({
        count: message.count,
        remaining: message.remaining || 0,
        total: totalVideos,
      });
      setButtonState('done');
      setStatus(doneMessage(message.count, message.remaining || 0), 'success');
      if ((message.remaining || 0) === 0) {
        emptyState.classList.remove('hidden');
        actionButton.classList.add('hidden');
      } else {
        emptyState.classList.add('hidden');
        actionButton.classList.remove('hidden');
      }
      highlightReviewLink();
    }
  });
});
