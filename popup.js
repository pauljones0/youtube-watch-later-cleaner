document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);

  const actionButton = $('actionButton');
  const statusDiv = $('status');
  const progressSection = $('progress');
  const countSpan = $('count');
  const totalLabel = $('totalLabel');
  const progressBar = $('progressBar');
  const etaDiv = $('eta');
  const reviewCard = $('reviewCard');
  const reviewYes = $('reviewYes');
  const reviewDismiss = $('reviewDismiss');
  const reviewLink = $('reviewLink');
  const emptyState = $('emptyState');
  const bugReport = $('bugReport');

  let currentTab = null;
  let videosRemoved = 0;
  let totalVideos = 0;
  let startTime = null;

  // --- Single button state machine ---
  // States: 'nav' | 'start' | 'stop' | 'done'

  let buttonState = 'start';

  const setButtonState = state => {
    buttonState = state;
    actionButton.className = ''; // reset
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

  // --- UI helpers ---

  const setStatus = (text, cls = '') => {
    statusDiv.textContent = text;
    statusDiv.className = 'status-bar ' + cls;
  };

  const setCount = count => {
    videosRemoved = count;
    countSpan.textContent = count.toLocaleString();
    updateProgress();
  };

  const updateProgress = () => {
    if (totalVideos > 0) {
      const pct = Math.min(100, (videosRemoved / totalVideos) * 100);
      progressBar.style.width = pct + '%';
      progressBar.classList.remove('indeterminate');
      totalLabel.textContent = `of ~${totalVideos.toLocaleString()}`;
    } else {
      progressBar.classList.add('indeterminate');
      progressBar.style.width = '';
      totalLabel.textContent = '';
    }

    if (startTime && videosRemoved > 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = videosRemoved / elapsed;
      if (totalVideos > 0 && rate > 0) {
        const remaining = totalVideos - videosRemoved;
        const etaSec = remaining / rate;
        etaDiv.textContent = remaining > 0 ? `~${formatDuration(etaSec)} remaining` : '';
      } else {
        etaDiv.textContent = `${rate.toFixed(1)}/s`;
      }
    }
  };

  const formatDuration = sec => {
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `${h}h ${m}m`;
  };

  // --- Review ---

  const showReviewPrompt = count => {
    if (count < 5) return;
    browser.storage.local.get('reviewDismissed').then(r => {
      if (r.reviewDismissed) return;
      const stat = $('reviewStat');
      if (stat) stat.textContent = count.toLocaleString();
      reviewCard.classList.remove('hidden');
    });
  };

  reviewYes.addEventListener('click', () => {
    browser.tabs.create({ url: 'https://addons.mozilla.org/firefox/addon/youtube-watch-later-cleaner/' });
    reviewCard.classList.add('hidden');
    browser.storage.local.set({ reviewDismissed: true });
  });

  reviewDismiss.addEventListener('click', () => {
    reviewCard.classList.add('hidden');
    browser.storage.local.set({ reviewDismissed: true });
  });

  reviewLink.addEventListener('click', e => {
    e.preventDefault();
    browser.tabs.create({ url: 'https://addons.mozilla.org/firefox/addon/youtube-watch-later-cleaner/' });
  });

  const highlightReviewLink = () => {
    reviewLink.classList.add('highlight');
  };

  // --- Bug Report ---

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

    // Format logs for clipboard
    const logLines = logs.map(l => {
      const ts = new Date(l.t).toISOString().substr(11, 12);
      return `[${ts}] ${l.l} ${l.m}`;
    }).join('\n');

    // Copy logs to clipboard
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

    // Build method description
    let method = state.method || 'unknown';
    if (state.method === 'fallback' && state.apiFailedAt > 0) {
      method = `API then fallback (switched at video #${state.apiFailedAt})`;
    } else if (state.method === 'fallback') {
      method = 'Fallback (API was not available)';
    } else if (state.method === 'api') {
      method = 'API (fast mode)';
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
      `Videos removed: ${state.count || 0}`,
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

  // --- Tab / page detection ---

  const updateInterface = async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return;
    currentTab = tabs[0];

    const isWL = currentTab.url.includes('youtube.com/playlist?list=WL');

    if (!isWL) {
      emptyState.classList.add('hidden');
      progressSection.classList.add('hidden');
      actionButton.classList.remove('hidden');
      setButtonState('nav');
      setStatus('Navigate to your Watch Later playlist.', 'warning');
      return;
    }

    // Read playlist count from DOM
    // null = page still loading, 0 = confirmed empty, N = has videos
    let playlistCount = null;
    try {
      const result = await browser.tabs.executeScript(currentTab.id, {
        code: `(() => {
          // Strategy 1: read the byline count ("3 videos")
          const el = document.querySelector('ytd-playlist-byline-renderer yt-formatted-string.byline-item');
          if (el) {
            const text = el.textContent.trim();
            const m = text.replace(/,/g, '').match(/(\\d+)/);
            if (m) return parseInt(m[1]);
            // "No videos" in byline — confirmed empty
            if (/no video/i.test(text)) return 0;
          }
          // Strategy 2: YouTube's empty playlist alert/message
          const empty = document.querySelector('ytd-playlist-video-list-renderer [id="empty-message"]')
            || document.querySelector('.empty-message');
          if (empty) return 0;
          // Strategy 3: playlist header exists but no video renderers
          const header = document.querySelector('ytd-playlist-header-renderer');
          const videos = document.querySelector('ytd-playlist-video-renderer');
          if (header && !videos) return 0;
          // Not enough info yet
          return null;
        })()`,
      });
      playlistCount = result?.[0] ?? null;
    } catch (_) {}

    // Query content script for current running state
    let state = null;
    try {
      state = await browser.tabs.sendMessage(currentTab.id, { command: 'status' });
    } catch (_) {}

    // --- Active cleaning ---
    if (state?.running) {
      emptyState.classList.add('hidden');
      progressSection.classList.remove('hidden');
      actionButton.classList.remove('hidden');
      videosRemoved = state.count;
      if (state.total > 0) totalVideos = state.total;
      startTime = state.startTime;
      setCount(state.count);
      setButtonState('stop');
      setStatus('Cleaning in progress...', 'success');
      return;
    }

    // --- Cleaning completed (popup was closed during run) ---
    if (state?.done && state.count > 0) {
      videosRemoved = state.count;
      if (state.total > 0) totalVideos = state.total;
      setCount(state.count);
      progressBar.style.width = '100%';
      progressBar.classList.remove('indeterminate');
      etaDiv.textContent = '';
      setButtonState('done');
      setStatus(`Done! Removed ${state.count.toLocaleString()} videos.`, 'success');
      // Show celebration if playlist is confirmed empty
      if (playlistCount === 0) {
        emptyState.classList.remove('hidden');
        progressSection.classList.add('hidden');
        actionButton.classList.add('hidden');
      } else {
        emptyState.classList.add('hidden');
        progressSection.classList.remove('hidden');
        actionButton.classList.remove('hidden');
      }
      showReviewPrompt(state.count);
      highlightReviewLink();
      return;
    }

    // --- Idle: playlist confirmed empty ---
    if (playlistCount === 0) {
      emptyState.classList.remove('hidden');
      progressSection.classList.add('hidden');
      actionButton.classList.add('hidden');
      setStatus('Nothing to clean!', 'success');
      highlightReviewLink();
      return;
    }

    // --- Idle: playlist has videos or still loading ---
    emptyState.classList.add('hidden');

    // Reset stale values from any prior run
    totalVideos = (playlistCount !== null && playlistCount > 0) ? playlistCount : 0;
    videosRemoved = 0;
    setCount(0);
    etaDiv.textContent = '';
    startTime = null;
    // Only show progress section if we know there are videos
    if (totalVideos > 0) {
      progressSection.classList.remove('hidden');
    } else {
      progressSection.classList.add('hidden');
    }
    if (playlistCount === null) {
      // Page still loading — hide button to prevent layout shift
      actionButton.classList.add('hidden');
      setStatus('Loading...', 'success');
      setTimeout(updateInterface, 1500);
    } else {
      actionButton.classList.remove('hidden');
      setButtonState('start');
      setStatus('Ready — click Start to begin.', 'success');
    }
  };

  await updateInterface();

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!currentTab || tabId !== currentTab.id) return;
    // Re-evaluate on URL change or page load complete (catches auto-refresh after cleaning)
    if (changeInfo.url || changeInfo.status === 'complete') updateInterface();
  });

  // --- Single button handler ---

  actionButton.addEventListener('click', () => {
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

    } else if (buttonState === 'start' || buttonState === 'done') {
      browser.tabs.sendMessage(currentTab.id, { command: 'start' });
      startTime = Date.now();
      setButtonState('stop');
      setStatus('Cleaning in progress...', 'success');
      progressSection.classList.remove('hidden');
      reviewCard.classList.add('hidden');

    } else if (buttonState === 'stop') {
      browser.tabs.sendMessage(currentTab.id, { command: 'stop' });
      setStatus('Stopping...', 'warning');
      actionButton.disabled = true;
    }
  });

  // --- Messages from content script ---

  browser.runtime.onMessage.addListener(message => {
    if (message.type === 'log') {
      // Smarter status text during active cleaning
      if (message.text.includes('Removing')) {
        // "Removing 102 videos..." — show as activity indicator
        setStatus(message.text, 'success');
      } else if (/^\d+ removed/.test(message.text)) {
        // "201 removed" — don't show redundant count, keep activity status
        setStatus('Cleaning in progress...', 'success');
      } else {
        // Done, errors, fallback messages — show as-is
        setStatus(message.text, message.class);
      }
    } else if (message.type === 'count') {
      setCount(message.count);
    } else if (message.type === 'error') {
      setStatus(message.text, 'error');
      setButtonState('start');
      if (message.text.includes('sign in') || message.text.includes('Sign in')) {
        setButtonState('nav');
      }
    } else if (message.type === 'complete') {
      setStatus(`Done! Removed ${message.count} videos.`, 'success');
      etaDiv.textContent = '';
      // Show celebration — page will refresh shortly
      emptyState.classList.remove('hidden');
      progressSection.classList.add('hidden');
      actionButton.classList.add('hidden');
      showReviewPrompt(message.count);
      highlightReviewLink();
    }
  });
});
