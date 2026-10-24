// Avatar builder data, without page code so the tests can use it. `styleInfo` is one
// entry of GET /api/avatar/options; `avatar` is the saved object (src/avatars.js).

import { Avatar } from '@dicebear/core';

// Makes every builder part explicit without changing the picture. For an old
// { style, seed } avatar the seed's picks come from DiceBear's toJSON().options.
export function explicitChoices(styleInfo, dicebearStyle, avatar) {
  const { style: _style, ...given } = avatar;
  let picked;
  try {
    picked = new Avatar(dicebearStyle, given).toJSON().options;
  } catch {
    // Options DiceBear won't draw: start again from the seed alone.
    return explicitChoices(styleInfo, dicebearStyle, { seed: String(avatar.seed ?? '') });
  }

  // Existing choices win: DiceBear omits parts the picture doesn't use.
  const own = (key) => given[key];

  const result = { style: styleInfo.id, seed: given.seed ?? '' };
  for (const component of styleInfo.components) {
    const key = `${component.name}Variant`;
    const variant = own(key) ?? picked[key];
    if (variant !== undefined) result[key] = variant;
    if (component.optional) {
      const shown = picked[key] !== undefined;
      result[`${component.name}Probability`] = shown ? 100 : 0;
    }
  }
  for (const color of styleInfo.colors) {
    const key = `${color.name}Color`;
    // DiceBear reports colours as a list; empty means none (see-through).
    const value = own(key) ?? picked[key]?.[0];
    if (value !== undefined) result[key] = value.toLowerCase();
  }
  return result;
}

// `variant` null means "None" (optional parts only).
export function withVariant(avatar, component, variant) {
  const next = { ...avatar };
  if (variant === null) {
    next[`${component.name}Probability`] = 0;
  } else {
    next[`${component.name}Variant`] = variant;
    if (component.optional) next[`${component.name}Probability`] = 100;
  }
  return next;
}

// `value` null means no colour (see-through background).
export function withColor(avatar, color, value) {
  const next = { ...avatar };
  if (value === null) delete next[`${color.name}Color`];
  else next[`${color.name}Color`] = value;
  return next;
}

export function selectedVariant(avatar, component) {
  if (component.optional && avatar[`${component.name}Probability`] === 0) return null;
  return avatar[`${component.name}Variant`] ?? null;
}

// 12 random hex characters, like the seeds the server makes.
export function randomSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Optional parts show about one time in three.
export function randomChoices(styleInfo) {
  let avatar = { style: styleInfo.id, seed: randomSeed() };
  for (const component of styleInfo.components) {
    const show = !component.optional || Math.random() < 1 / 3;
    avatar = withVariant(avatar, component, pick(component.variants).name);
    if (!show) avatar = withVariant(avatar, component, null);
  }
  for (const color of styleInfo.colors) {
    avatar = withColor(avatar, color, pick(color.values));
  }
  return avatar;
}
