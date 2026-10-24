// Draws avatars in the browser from saved DiceBear options ({ style, seed, ...parts });
// no images are stored. Everything except `style` is passed to DiceBear as is
// (option names: src/avatars.js). DiceBear is bundled, so this works offline.
// Only CC0-licensed styles are offered.

import { Avatar, Style } from '@dicebear/core';
// Import attribute required by Node (the unit tests import this file).
import lorelei from '@dicebear/styles/lorelei.json' with { type: 'json' };
import notionists from '@dicebear/styles/notionists.json' with { type: 'json' };
import openPeeps from '@dicebear/styles/open-peeps.json' with { type: 'json' };

export const AVATAR_STYLES = {
  lorelei: new Style(lorelei),
  notionists: new Style(notionists),
  'open-peeps': new Style(openPeeps),
};

export function avatarDataUri(options = {}) {
  const { style = 'lorelei', ...rest } = options ?? {};
  const definition = AVATAR_STYLES[style] ?? AVATAR_STYLES.lorelei;
  try {
    return new Avatar(definition, { size: 128, ...rest }).toDataUri();
  } catch {
    // DiceBear throws on unknown options; a hand-edited row falls back to the seed alone.
    const seed = typeof rest.seed === 'string' ? rest.seed : '';
    return new Avatar(definition, { size: 128, seed }).toDataUri();
  }
}

export function avatarImg(options, { size = 64, alt = '' } = {}) {
  const img = document.createElement('img');
  img.src = avatarDataUri(options);
  img.width = size;
  img.height = size;
  img.alt = alt;
  img.className = 'avatar';
  return img;
}
