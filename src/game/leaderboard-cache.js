// Prebuilt per-player results screens (top 5, neighbours, avatars as SVG).
//
// Used only while the `leaderboard-leak` fault-injection switch is on, which
// makes this cache leak memory on purpose.

import { createRequire } from 'node:module';
import { Avatar, Style } from '@dicebear/core';
import { onSwitch } from '../chaos/switches.js';

// Same styles as web/js/lib/avatar.js, loaded lazily.
const require = createRequire(import.meta.url);
let styles = null;
function avatarStyles() {
  styles ??= {
    lorelei: new Style(require('@dicebear/styles/lorelei.json')),
    notionists: new Style(require('@dicebear/styles/notionists.json')),
    'open-peeps': new Style(require('@dicebear/styles/open-peeps.json')),
  };
  return styles;
}

function drawAvatar({ style = 'lorelei', ...options } = {}) {
  const definition = avatarStyles()[style] ?? avatarStyles().lorelei;
  return new Avatar(definition, { size: 128, ...options }).toDataUri();
}

const TOP_COUNT = 5;
const NEIGHBOURS = 2;

const cache = new Map();

function cacheKey(gameId, questionNo) {
  return `${gameId}:${questionNo}`;
}

// `ranked` is the output of rankByScore (scoring.js).
export function rememberLeaderboard(game, questionNo, ranked) {
  const avatars = new Map(ranked.map((p) => [p.id, drawAvatar(p.avatar)]));
  const entry = (p) => ({ id: p.id, name: p.name, score: p.score, rank: p.rank, avatar: avatars.get(p.id) });
  const top = ranked.slice(0, TOP_COUNT).map(entry);

  const screens = new Map();
  ranked.forEach((p, index) => {
    const near = ranked.slice(Math.max(0, index - NEIGHBOURS), index + NEIGHBOURS + 1).map(entry);
    screens.set(p.id, JSON.stringify({ questionNo, you: entry(p), top, near }));
  });
  // Timestamped so a newer build never overwrites one still being read.
  cache.set(`${cacheKey(game.id, questionNo)}:${Date.now()}`, { builtAt: Date.now(), screens });
}

export function isCached(game, questionNo) {
  return cache.has(cacheKey(game.id, questionNo));
}

// Turning the switch off releases the memory.
onSwitch('leaderboard-leak', (on) => {
  if (!on) cache.clear();
});
