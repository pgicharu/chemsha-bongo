// Tests for avatar options, validation, and drawing of legacy { style, seed } avatars.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Avatar } from '@dicebear/core';

import {
  AVATAR_OPTIONS,
  AVATAR_STYLE_NAMES,
  AvatarError,
  randomAvatar,
  validateAvatar,
} from '../src/avatars.js';
import { AVATAR_STYLES, avatarDataUri } from '../web/js/lib/avatar.js';
import { explicitChoices, randomChoices, withColor, withVariant } from '../web/js/avatar/choices.js';

const styleInfo = (id) => AVATAR_OPTIONS.styles.find((style) => style.id === id);
const component = (styleId, name) => styleInfo(styleId).components.find((c) => c.name === name);

function rejects(avatar, pattern) {
  assert.throws(() => validateAvatar(avatar), (err) => err instanceof AvatarError && pattern.test(err.message));
}

test('the options offer exactly the three CC0 styles', () => {
  assert.deepEqual(
    AVATAR_OPTIONS.styles.map((style) => style.id),
    ['lorelei', 'notionists', 'open-peeps'],
  );
  assert.deepEqual(AVATAR_STYLE_NAMES, ['lorelei', 'notionists', 'open-peeps']);
});

test('the options come from the DiceBear definitions', () => {
  assert.equal(component('lorelei', 'hair').variants.length, 48);
  assert.equal(component('lorelei', 'glasses').optional, true);
  assert.equal(component('lorelei', 'hair').optional, false);
  assert.equal(component('open-peeps', 'head').variants[0].name, 'afro');
  const skin = styleInfo('open-peeps').colors.find((c) => c.name === 'skin');
  assert.equal(skin.free, false);
  assert.ok(skin.values.includes('#694d3d'));
  const loreleiHair = styleInfo('lorelei').colors.find((c) => c.name === 'hair');
  assert.equal(loreleiHair.free, true);
});

test('an old { style, seed } avatar is valid', () => {
  for (const style of AVATAR_STYLE_NAMES) {
    assert.deepEqual(validateAvatar({ style, seed: 'k3m9x2' }), { style, seed: 'k3m9x2' });
  }
});

test('a fully chosen avatar is valid in every style', () => {
  const avatars = [
    {
      style: 'lorelei',
      seed: 'abc123',
      hairVariant: 'variant12',
      eyesVariant: 'variant05',
      mouthVariant: 'sad01',
      glassesVariant: 'variant02',
      glassesProbability: 100,
      beardProbability: 0,
      skinColor: '#d08b5b',
      hairColor: '#c93305',
      backgroundColor: '#b6e3f4',
    },
    { style: 'notionists', seed: 'abc123', hairVariant: 'hat', gestureVariant: 'ok', gestureProbability: 100 },
    {
      style: 'open-peeps',
      seed: 'abc123',
      headVariant: 'afro',
      expressionVariant: 'awe',
      skinColor: '#694d3d',
      clothingColor: '#ffcf77',
    },
  ];
  for (const avatar of avatars) assert.deepEqual(validateAvatar(avatar), avatar);
});

test('colours are stored in lower case', () => {
  const clean = validateAvatar({ style: 'lorelei', seed: 'a', backgroundColor: '#B6E3F4' });
  assert.equal(clean.backgroundColor, '#b6e3f4');
});

test('random avatars (server and browser) always pass the checks', () => {
  for (let i = 0; i < 200; i += 1) {
    validateAvatar(randomAvatar());
    for (const style of AVATAR_OPTIONS.styles) validateAvatar(randomChoices(style));
  }
});

test('rejects anything that is not an object', () => {
  for (const value of [undefined, null, 'lorelei', 42, true, ['lorelei']]) {
    rejects(value, /must be an object/);
  }
});

test('rejects an unknown or missing style', () => {
  rejects({ style: 'adventurer', seed: 'a' }, /Unknown style/);
  rejects({ seed: 'a' }, /Unknown style/);
  rejects({ style: ['lorelei'], seed: 'a' }, /Unknown style/);
});

test('rejects a missing or odd seed', () => {
  rejects({ style: 'lorelei' }, /seed/);
  rejects({ style: 'lorelei', seed: '' }, /seed/);
  rejects({ style: 'lorelei', seed: 'a b' }, /seed/);
  rejects({ style: 'lorelei', seed: 'x'.repeat(65) }, /seed/);
  rejects({ style: 'lorelei', seed: 12 }, /seed/);
});

test('rejects unknown keys, including DiceBear options we do not offer', () => {
  rejects({ style: 'lorelei', seed: 'a', hat: 'yes' }, /"hat" is not an option for lorelei/);
  rejects({ style: 'lorelei', seed: 'a', size: 4000 }, /"size" is not an option/);
  rejects({ style: 'lorelei', seed: 'a', title: 'hi' }, /"title" is not an option/);
  rejects({ style: 'notionists', seed: 'a', expressionVariant: 'awe' }, /not an option for notionists/);
  rejects({ style: 'notionists', seed: 'a', clothesVariant: 'variant01' }, /not an option/);
  rejects(JSON.parse('{"style":"lorelei","seed":"a","__proto__":{"admin":true}}'), /"__proto__" is not an option/);
});

test('rejects a variant the style does not have', () => {
  rejects({ style: 'lorelei', seed: 'a', hairVariant: 'variant99' }, /Hair: "variant99" is not one of the choices/);
  rejects({ style: 'open-peeps', seed: 'a', headVariant: 'variant01' }, /not one of the choices/);
});

test('rejects a probability other than 0 or 100, and on parts that are always shown', () => {
  rejects({ style: 'lorelei', seed: 'a', glassesProbability: 50 }, /0 \(hidden\) or 100/);
  rejects({ style: 'lorelei', seed: 'a', glassesProbability: '100' }, /0 \(hidden\) or 100/);
  rejects({ style: 'lorelei', seed: 'a', hairProbability: 0 }, /not an option/);
});

test('rejects colours that are not allowed', () => {
  rejects({ style: 'open-peeps', seed: 'a', skinColor: '#00ff00' }, /Skin: "#00ff00" is not an allowed colour/);
  for (const bad of ['red', '#fff', '#12345g', '#1234567', 'b6e3f4', 'rgb(0,0,0)', '']) {
    rejects({ style: 'lorelei', seed: 'a', backgroundColor: bad }, /not an allowed colour/);
  }
});

test('rejects values that try to inject markup into the SVG', () => {
  rejects({ style: 'lorelei', seed: 'a', hairColor: '#000000"/><script>alert(1)</script>' }, /not an allowed colour/);
  rejects({ style: 'lorelei', seed: 'a', hairVariant: 'variant01"><script>' }, /not one of the choices/);
  rejects({ style: 'lorelei', seed: '"><script>alert(1)</script>' }, /seed/);
  rejects({ style: 'lorelei"><svg onload=alert(1)>', seed: 'a' }, /Unknown style/);
});

test('rejects wrong types', () => {
  rejects({ style: 'lorelei', seed: 'a', hairVariant: ['variant01'] }, /Hair: expected the name of a choice/);
  rejects({ style: 'lorelei', seed: 'a', hairVariant: { variant01: 1 } }, /expected the name of a choice/);
  rejects({ style: 'lorelei', seed: 'a', hairVariant: null }, /expected the name of a choice/);
  rejects({ style: 'lorelei', seed: 'a', backgroundColor: ['#ffffff', '#000000'] }, /Background: expected a colour/);
  rejects({ style: 'lorelei', seed: 'a', backgroundColor: 0xffffff }, /expected a colour/);
});

test('rejects an avatar that is too big', () => {
  rejects({ style: 'lorelei', seed: 'a', hairVariant: 'variant01', padding: 'x'.repeat(3000) }, /too big/);
});

test('an old { style, seed } avatar draws exactly as before', () => {
  for (const style of AVATAR_STYLE_NAMES) {
    const direct = new Avatar(AVATAR_STYLES[style], { size: 128, seed: 'k3m9x2' }).toDataUri();
    assert.equal(avatarDataUri({ style, seed: 'k3m9x2' }), direct);
  }
  assert.notEqual(avatarDataUri({ style: 'lorelei', seed: 'a' }), avatarDataUri({ style: 'lorelei', seed: 'b' }));
});

test('writing out the choices the seed made does not change the picture', () => {
  // Mirrors what the builder does when it opens an old avatar.
  for (const style of AVATAR_OPTIONS.styles) {
    for (let i = 0; i < 50; i += 1) {
      const old = { style: style.id, seed: `seed${i}` };
      const explicit = explicitChoices(style, AVATAR_STYLES[style.id], old);
      assert.equal(avatarDataUri(explicit), avatarDataUri(old));
      assert.deepEqual(validateAvatar(explicit), explicit);
    }
  }
});

test('opening a saved builder avatar keeps every choice, even ones the picture does not use', () => {
  // headContrastColor is ignored by DiceBear for an afro but must still be kept,
  // or the page reports unsaved changes after saving.
  const peeps = styleInfo('open-peeps');
  const saved = {
    ...explicitChoices(peeps, AVATAR_STYLES['open-peeps'], { style: 'open-peeps', seed: 'abc' }),
    headVariant: 'afro',
    headContrastColor: '#c93305',
  };
  assert.deepEqual(explicitChoices(peeps, AVATAR_STYLES['open-peeps'], saved), saved);
  for (const style of AVATAR_OPTIONS.styles) {
    for (let i = 0; i < 50; i += 1) {
      const avatar = randomChoices(style);
      assert.deepEqual(explicitChoices(style, AVATAR_STYLES[style.id], avatar), avatar);
    }
  }
});

test('choices change the picture, and "None" hides an optional part', () => {
  const style = styleInfo('lorelei');
  const glasses = component('lorelei', 'glasses');
  const base = explicitChoices(style, AVATAR_STYLES.lorelei, { style: 'lorelei', seed: 'abc' });
  const withGlasses = withVariant(base, glasses, 'variant03');
  const without = withVariant(withGlasses, glasses, null);
  assert.equal(withGlasses.glassesProbability, 100);
  assert.equal(without.glassesProbability, 0);
  assert.notEqual(avatarDataUri(withGlasses), avatarDataUri(without));

  const background = style.colors.find((c) => c.name === 'background');
  assert.equal(withColor(base, background, '#b6e3f4').backgroundColor, '#b6e3f4');
  assert.equal(withColor(base, background, null).backgroundColor, undefined);
});

test('an avatar DiceBear refuses still draws (from its seed) instead of breaking the page', () => {
  const broken = { style: 'lorelei', seed: 'abc', hairColor: 'not a colour', bogus: 1 };
  assert.equal(avatarDataUri(broken), avatarDataUri({ style: 'lorelei', seed: 'abc' }));
  assert.equal(avatarDataUri({ style: 'nope', seed: 'abc' }), avatarDataUri({ style: 'lorelei', seed: 'abc' }));
  assert.match(avatarDataUri(null), /^data:image\/svg\+xml/);
});
