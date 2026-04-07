/**
 * YouTube Watch Later Playlist Cleaner (Standalone Console Script)
 * Fully API-driven: fetches all videos via browse API (including hidden),
 * then batch-removes ~100 at a time. No UI interaction needed.
 * Paste this into the browser console while on youtube.com/playlist?list=WL
 */

(function() {
  if (!window.location.href.match(/youtube\.com\/playlist\?list=WL/)) {
    console.log('Run this on youtube.com/playlist?list=WL');
    return;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function genAuth() {
    const cookies = document.cookie.split(';').reduce((acc, c) => {
      const [k, ...v] = c.trim().split('=');
      acc[k] = v.join('=');
      return acc;
    }, {});
    const sapisid = cookies['SAPISID'] || cookies['__Secure-3PAPISID'];
    if (!sapisid) return null;
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1',
      new TextEncoder().encode(`${ts} ${sapisid} https://www.youtube.com`));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  const headers = auth => ({
    'Content-Type': 'application/json',
    'Authorization': auth,
    'X-Goog-AuthUser': '0',
    'X-Origin': 'https://www.youtube.com',
  });

  const apiKey = () => window.ytcfg?.data_?.INNERTUBE_API_KEY;
  const context = () => window.ytcfg?.data_?.INNERTUBE_CONTEXT;

  function timedFetch(url, opts, ms = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  async function fetchPage(auth, contToken) {
    const body = contToken
      ? { context: context(), continuation: contToken }
      : { context: context(), browseId: 'VLWL', params: decodeURIComponent('wgYCCAA%3D') };

    const resp = await timedFetch(`/youtubei/v1/browse?key=${apiKey()}&prettyPrint=false`, {
      method: 'POST', headers: headers(auth), credentials: 'include', body: JSON.stringify(body),
    });
    const rb = await resp.json().catch(() => null);
    if (!rb) return { ids: [], cont: null };

    let items;
    if (contToken) {
      const action = rb.onResponseReceivedActions?.find(a => a.appendContinuationItemsAction);
      items = action?.appendContinuationItemsAction?.continuationItems || [];
    } else {
      const pvl = rb.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]
        ?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer;
      items = pvl?.contents || [];
    }

    const ids = items.filter(i => i.playlistVideoRenderer?.setVideoId)
      .map(i => i.playlistVideoRenderer.setVideoId);

    const contItem = items.find(i => i.continuationItemRenderer);
    const cmds = contItem?.continuationItemRenderer?.continuationEndpoint?.commandExecutorCommand?.commands;
    const cont = cmds?.find(c => c.continuationCommand)?.continuationCommand?.token
      || contItem?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
      || null;

    return { ids, cont };
  }

  async function batchRemove(auth, setVideoIds) {
    const body = {
      context: context(), playlistId: 'WL',
      actions: setVideoIds.map(id => ({ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' })),
      params: 'CAFAAQ==',
    };
    const resp = await timedFetch(`/youtubei/v1/browse/edit_playlist?key=${apiKey()}&prettyPrint=false`, {
      method: 'POST', headers: headers(auth), credentials: 'include', body: JSON.stringify(body),
    });
    const rb = await resp.json().catch(() => null);
    return rb?.status === 'STATUS_SUCCEEDED';
  }

  (async () => {
    const auth = await genAuth();
    if (!auth) { console.log('Auth unavailable. Are you signed in?'); return; }

    let totalRemoved = 0;
    let cont = null;
    const t0 = performance.now();

    console.log('Fetching playlist (including hidden videos)...');

    while (true) {
      const page = await fetchPage(auth, cont);

      if (page.ids.length === 0) {
        if (totalRemoved === 0) console.log('Playlist is already empty.');
        else console.log(`\nDone! Removed ${totalRemoved} videos in ${Math.round((performance.now() - t0) / 1000)}s.\n`);
        return;
      }

      for (let i = 0; i < page.ids.length; i += 100) {
        const batch = page.ids.slice(i, i + 100);
        const bt0 = performance.now();
        const ok = await batchRemove(auth, batch);
        const ms = Math.round(performance.now() - bt0);

        if (ok) {
          totalRemoved += batch.length;
          console.log(`Removed ${totalRemoved} (+${batch.length} in ${ms}ms, ${Math.round(ms / batch.length)}ms/ea)`);
        } else {
          console.log(`Batch of ${batch.length} failed. Retrying...`);
          const newAuth = await genAuth();
          const retry = await batchRemove(newAuth, batch);
          if (retry) {
            totalRemoved += batch.length;
            console.log(`Retry succeeded. ${totalRemoved} removed total.`);
          } else {
            console.log('Retry failed. Try refreshing the page.');
            return;
          }
        }

        await sleep(300);
      }

      if (page.cont) {
        cont = page.cont;
        await sleep(200);
      } else {
        // Final check
        const finalPage = await fetchPage(auth, null);
        if (finalPage.ids.length === 0) {
          console.log(`\nDone! Removed ${totalRemoved} videos in ${Math.round((performance.now() - t0) / 1000)}s.\n`);
          return;
        }
        cont = null; // loop again from the start
      }
    }
  })();
})();
