// The embed page (/e/:id): the share page's player, nothing else. Counts a view on first play,
// like the share page (an embed is never the owner's copy: cookies don't reach another site's frame).
import { Player } from './player.js';
import { withTrim } from './timeline.js';

const { video: v, ownerName } = JSON.parse(document.getElementById('shuttle-data').textContent);
const player = new Player(document.getElementById('player-host'), { video: { ...v, cuts: withTrim(v.cuts || [], v.trim) }, ownerName, owner: false });
let counted = false;
player.addEventListener('play', () => {
  if (counted) return;
  counted = true;
  fetch(`/api/videos/${v.id}/view`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
});
