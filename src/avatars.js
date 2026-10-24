// Server-side avatar helpers: builder options, validation, random avatars.
// The browser renders (web/js/lib/avatar.js). users.avatar stores DiceBear
// options, not an image: { style, seed, ...choices }, where choices use
// DiceBear's own option names (<component>Variant, <component>Probability,
// <colour>Color) so they can be passed to DiceBear unchanged.

import { createRequire } from 'node:module';
import { randomBytes, randomInt } from 'node:crypto';
import { Avatar, Style } from '@dicebear/core';

// CC0-licensed styles only.
export const AVATAR_STYLE_NAMES = ['lorelei', 'notionists', 'open-peeps'];

const require = createRequire(import.meta.url);
const DEFINITIONS = {
  lorelei: require('@dicebear/styles/lorelei.json'),
  notionists: require('@dicebear/styles/notionists.json'),
  'open-peeps': require('@dicebear/styles/open-peeps.json'),
};
const STYLES = Object.fromEntries(Object.entries(DEFINITIONS).map(([id, definition]) => [id, new Style(definition)]));

// ---- What the builder offers ---------------------------------------------------
//
// Components not listed here are left to the seed. A colour with several
// values in the style definition is a fixed palette; with one or none it is
// only a default, so any '#rrggbb' is accepted (with suggestions).

const SKIN_TONES = ['#ffdbb4', '#edb98a', '#d08b5b', '#ae5d29', '#694d3d', '#4a312c'];
const HAIR_COLOURS = ['#2c1b18', '#4a312c', '#724133', '#a55728', '#c93305', '#d6b370', '#e8e1e1', '#f59797'];
const BACKGROUNDS = ['#ffd5dc', '#ffdfbf', '#fdea6b', '#c0f0c0', '#b6e3f4', '#c0aede', '#d1d4f9', '#f4f1ea'];

const BUILDER = {
  lorelei: {
    label: 'Lorelei',
    components: {
      hair: 'Hair',
      eyes: 'Eyes',
      eyebrows: 'Eyebrows',
      mouth: 'Mouth',
      nose: 'Nose',
      glasses: 'Glasses',
      earrings: 'Earrings',
      beard: 'Beard',
      freckles: 'Freckles',
    },
    colors: {
      skin: { label: 'Skin', suggestions: ['#ffffff', ...SKIN_TONES] },
      hair: { label: 'Hair colour', suggestions: ['#000000', ...HAIR_COLOURS] },
      background: { label: 'Background', suggestions: BACKGROUNDS },
    },
  },
  notionists: {
    label: 'Notionists',
    components: {
      hair: 'Hair',
      eyes: 'Eyes',
      eyebrows: 'Eyebrows',
      mouth: 'Mouth',
      nose: 'Nose',
      glasses: 'Glasses',
      beard: 'Beard',
      gesture: 'Hands',
    },
    // Notionists' two colours tint everything at once, so only background is offered.
    colors: {
      background: { label: 'Background', suggestions: BACKGROUNDS },
    },
  },
  'open-peeps': {
    label: 'Open Peeps',
    components: {
      head: 'Hair',
      expression: 'Face',
      facialHair: 'Beard',
      accessories: 'Glasses',
      mask: 'Mask',
    },
    colors: {
      skin: { label: 'Skin' },
      headContrast: { label: 'Hair colour', hint: 'Only shows on some hairstyles.' },
      clothing: { label: 'Clothes' },
      background: { label: 'Background', suggestions: BACKGROUNDS },
    },
  },
};

// 'variant07' -> 'Hair 7';  'mediumBangs3' -> 'Medium bangs 3';  'happy01' -> 'Happy 1'
function variantLabel(componentLabel, name) {
  const numbered = /^variant(\d+)$/.exec(name);
  if (numbered) return `${componentLabel} ${Number(numbered[1])}`;
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/\b0+(\d)/g, '$1')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function describeStyle(id) {
  const definition = DEFINITIONS[id];
  const builder = BUILDER[id];

  const components = Object.entries(builder.components).map(([name, label]) => {
    const component = definition.components[name];
    // probability < 100: the part is optional, so "None" is offered.
    const optional = (component.probability ?? 100) < 100;
    return {
      name,
      label,
      optional,
      variants: Object.keys(component.variants).map((variant) => ({
        name: variant,
        label: variantLabel(label, variant),
      })),
    };
  });

  const colors = Object.entries(builder.colors).map(([name, { label, hint, suggestions }]) => {
    const fromDefinition = definition.colors?.[name]?.values ?? [];
    const free = fromDefinition.length <= 1;
    return {
      name,
      label,
      ...(hint ? { hint } : {}),
      free,
      values: free ? suggestions : fromDefinition.map((value) => value.toLowerCase()),
    };
  });

  return { id, label: builder.label, components, colors };
}

// Served as-is by GET /api/avatar/options.
export const AVATAR_OPTIONS = { styles: AVATAR_STYLE_NAMES.map(describeStyle) };

// ---- Checking a saved avatar ----------------------------------------------------
//
// Strict allowlist: avatars render as SVG on other players' screens and
// DiceBear has had an advisory for unescaped option values, so only known
// option names and values are accepted rather than relying on DiceBear.

const AVATAR_MAX_JSON_LENGTH = 2000;

const SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_COLOUR = /^#[0-9a-f]{6}$/;

export class AvatarError extends Error {}

// Each check returns the normalised value or throws an AvatarError.

function variantCheck(component) {
  const variants = new Set(component.variants.map((v) => v.name));
  return (value) => {
    if (typeof value !== 'string') throw new AvatarError(`${component.label}: expected the name of a choice.`);
    if (!variants.has(value)) {
      throw new AvatarError(`${component.label}: "${value.slice(0, 40)}" is not one of the choices.`);
    }
    return value;
  };
}

function probabilityCheck(component) {
  return (value) => {
    if (value !== 0 && value !== 100) {
      throw new AvatarError(`${component.label}: probability must be 0 (hidden) or 100 (shown).`);
    }
    return value;
  };
}

function colorCheck(color) {
  const allowed = new Set(color.values);
  return (value) => {
    if (typeof value !== 'string') throw new AvatarError(`${color.label}: expected a colour such as #b6e3f4.`);
    const hex = value.toLowerCase();
    const ok = color.free ? HEX_COLOUR.test(hex) : allowed.has(hex);
    if (!ok) throw new AvatarError(`${color.label}: "${value.slice(0, 40)}" is not an allowed colour.`);
    return hex;
  };
}

// Option names missing from the Map are rejected.
function checksForStyle(style) {
  const checks = new Map();
  for (const component of style.components) {
    checks.set(`${component.name}Variant`, variantCheck(component));
    if (component.optional) checks.set(`${component.name}Probability`, probabilityCheck(component));
  }
  for (const color of style.colors) {
    checks.set(`${color.name}Color`, colorCheck(color));
  }
  return checks;
}

const CHECKS = new Map(AVATAR_OPTIONS.styles.map((style) => [style.id, checksForStyle(style)]));

// Returns a clean copy to store; AvatarError messages are user-facing.
export function validateAvatar(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AvatarError('The avatar must be an object.');
  }
  if (JSON.stringify(input).length > AVATAR_MAX_JSON_LENGTH) {
    throw new AvatarError('The avatar is too big.');
  }

  const { style, seed, ...choices } = input;
  if (typeof style !== 'string' || !CHECKS.has(style)) {
    throw new AvatarError(`Unknown style. Choose one of: ${AVATAR_STYLE_NAMES.join(', ')}.`);
  }
  if (typeof seed !== 'string' || !SEED_PATTERN.test(seed)) {
    throw new AvatarError('The seed must be 1 to 64 letters, digits, - or _.');
  }

  const checks = CHECKS.get(style);
  const options = { seed };
  for (const [key, value] of Object.entries(choices)) {
    const check = checks.get(key);
    if (!check) throw new AvatarError(`"${key.slice(0, 40)}" is not an option for ${style}.`);
    options[key] = check(value);
  }

  // DiceBear throws on options it cannot render.
  try {
    new Avatar(STYLES[style], options);
  } catch {
    throw new AvatarError('That avatar could not be drawn.');
  }
  return { style, ...options };
}

// ---- Random avatars ---------------------------------------------------------------

function pick(list) {
  return list[randomInt(list.length)];
}

// Optional parts appear at DiceBear's own probability.
export function randomAvatar() {
  const style = pick(AVATAR_OPTIONS.styles);
  const avatar = { style: style.id, seed: randomBytes(6).toString('hex') };

  for (const component of style.components) {
    avatar[`${component.name}Variant`] = pick(component.variants).name;
    if (component.optional) {
      const chance = DEFINITIONS[style.id].components[component.name].probability;
      avatar[`${component.name}Probability`] = randomInt(100) < chance ? 100 : 0;
    }
  }
  for (const color of style.colors) {
    // Background stays transparent.
    if (color.name !== 'background') avatar[`${color.name}Color`] = pick(color.values);
  }
  return avatar;
}
