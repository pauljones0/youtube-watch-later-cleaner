const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
const context = vm.createContext({ WLCCore: require('../cleaner-core.js'), window: {} });
vm.runInContext(source.slice(0, source.indexOf('  const cleaner =')) + 'globalThis.matches = removalMatches;})();', context);
test('native removal requires exactly one action for the selected playlist entry', () => {
  const info = { setVideoId: 'selected', videoId: 'video' };
  const menu = (actions, playlistId = 'WL') => ({ serviceEndpoint: { playlistEditEndpoint: { playlistId, actions } } });
  const selected = { action: 'ACTION_REMOVE_VIDEO', setVideoId: 'selected' };
  assert.equal(context.matches(menu([selected]), info), true);
  assert.equal(context.matches(menu([selected, { action: 'ACTION_REMOVE_VIDEO', setVideoId: 'keep' }]), info), false);
  assert.equal(context.matches(menu([selected], 'OTHER'), info), false);
  assert.equal(context.matches(menu([{ ...selected, setVideoId: 'keep' }]), info), false);
});
