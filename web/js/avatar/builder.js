// Avatar builder (/avatar). Saves an options object (src/avatars.js), not a picture;
// choices come from GET /api/avatar/options and the server validates against them.
// The preview redraws at once; picker thumbnails redraw in batches so slow phones
// don't freeze.

import { api } from '../lib/api.js';
import { AVATAR_STYLES, avatarDataUri } from '../lib/avatar.js';
import { renderNav, requireLogin } from '../lib/session.js';
import { errorMessage, setNotice } from '../auth/forms.js';
import {
  explicitChoices,
  randomChoices,
  selectedVariant,
  withColor,
  withVariant,
} from './choices.js';

const me = await requireLogin();
renderNav();

const form = document.getElementById('builder');
const preview = document.getElementById('preview');
const notice = document.getElementById('notice');
const unsaved = document.getElementById('unsaved');
const saveButton = document.getElementById('save-button');
const styleOptions = document.getElementById('style-options');
const partPickers = document.getElementById('part-pickers');

// Per style: zoom and transform-origin (x%, y%) for face-part thumbnails, found by
// trial. The origin sits just beyond the face centre (far right for open-peeps).
const FACE_ZOOM = {
  lorelei: { scale: 2, origin: '47% 66%' },
  notionists: { scale: 2.6, origin: '47% 47%' },
  'open-peeps': { scale: 2.2, origin: '74% 63%' },
};
const FACE_PARTS = new Set([
  'eyes', 'eyebrows', 'mouth', 'nose', 'glasses', 'earrings', 'beard', 'freckles',
  'expression', 'facialHair', 'accessories', 'mask',
]);

// ---- State ------------------------------------------------------------------

let options;
let saved; // the avatar as saved on the account, with every choice written out
let current;
const drafts = new Map();

const styleImages = new Map();

function styleInfo(id) {
  return options.styles.find((style) => style.id === id);
}

function sameAvatar(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

function fromSaved(avatar) {
  const info = styleInfo(avatar?.style) ?? options.styles[0];
  return explicitChoices(info, AVATAR_STYLES[info.id], { ...avatar, style: info.id });
}

// ---- Small helpers ----------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tile({ group, value, label, face, checked, onChoose }) {
  const wrapper = el('label', 'tile');
  wrapper.title = label;
  const input = el('input', 'tile__input');
  input.type = 'radio';
  input.name = group;
  input.value = value;
  input.checked = checked;
  // A radio only fires 'change' when it becomes the checked one.
  input.addEventListener('change', onChoose);
  const frame = el('span', 'tile__face');
  frame.append(face);
  wrapper.append(input, frame, el('span', 'visually-hidden', label));
  return wrapper;
}

function thumbnail() {
  const img = el('img', 'tile__image');
  img.width = 64;
  img.height = 64;
  img.alt = '';
  return img;
}

// ---- Thumbnails: redrawn in small batches ------------------------------------

// [{ img, group, draw: (avatar) => avatar options }]
let thumbnails = [];
const stale = new Set();
let drawing = false;
// Small enough that a cheap phone draws one batch well within a frame.
const THUMBNAILS_PER_FRAME = 24;

// Skips `skipGroup` (each of its pictures shows its own choice). Draws one batch per
// frame from the latest `current`, so quick changes never leave stale pictures.
function redrawThumbnails(skipGroup) {
  for (const thumb of thumbnails) {
    if (thumb.group !== skipGroup) stale.add(thumb);
  }
  if (!drawing) {
    drawing = true;
    requestAnimationFrame(drawBatch);
  }
}

function drawBatch() {
  for (const thumb of [...stale].slice(0, THUMBNAILS_PER_FRAME)) {
    stale.delete(thumb);
    thumb.img.src = avatarDataUri(thumb.draw(current));
  }
  if (stale.size > 0) requestAnimationFrame(drawBatch);
  else drawing = false;
}

// ---- Drawing the pickers ------------------------------------------------------

function renderStylePicker() {
  styleImages.clear();
  styleOptions.replaceChildren(
    ...options.styles.map((info) => {
      const img = thumbnail();
      img.src = avatarDataUri(drafts.get(info.id) ?? fromSaved({ seed: current.seed, style: info.id }));
      styleImages.set(info.id, img);
      const option = tile({
        group: 'style',
        value: info.id,
        label: info.label,
        face: img,
        checked: info.id === current.style,
        onChoose: () => chooseStyle(info.id),
      });
      option.classList.add('tile--style');
      option.append(el('span', 'tile__caption', info.label));
      return option;
    }),
  );
}

function renderPartPickers() {
  const info = styleInfo(current.style);
  thumbnails = [];
  stale.clear();
  partPickers.replaceChildren(
    ...info.components.map(componentPicker),
    ...info.colors.map(colorPicker),
  );
}

function componentPicker(component) {
  const group = `part-${component.name}`;
  const fieldset = el('fieldset', 'picker');
  fieldset.append(el('legend', 'picker__legend', component.label));
  const row = el('div', 'picker__options');
  if (FACE_PARTS.has(component.name)) {
    row.classList.add('picker__options--zoom');
    row.style.setProperty('--zoom-origin', FACE_ZOOM[current.style].origin);
    row.style.setProperty('--zoom-scale', FACE_ZOOM[current.style].scale);
  }

  const chosen = selectedVariant(current, component);
  const choices = component.variants.map((variant) => ({ value: variant.name, label: variant.label }));
  if (component.optional) choices.unshift({ value: null, label: 'None' });

  for (const choice of choices) {
    const img = thumbnail();
    const draw = (avatar) => withVariant(avatar, component, choice.value);
    thumbnails.push({ img, group, draw });
    row.append(
      tile({
        group,
        value: choice.value ?? 'none',
        label: choice.label,
        face: img,
        checked: choice.value === chosen,
        onChoose: () => update(withVariant(current, component, choice.value), group),
      }),
    );
  }
  fieldset.append(row);
  return fieldset;
}

function colorPicker(color) {
  const group = `color-${color.name}`;
  const fieldset = el('fieldset', 'picker');
  fieldset.append(el('legend', 'picker__legend', color.label));
  if (color.hint) fieldset.append(el('p', 'picker__hint', color.hint));
  const row = el('div', 'picker__options');

  const chosen = current[`${color.name}Color`] ?? null;
  // null is "None" (only the background may be see-through).
  const values = color.name === 'background' ? [null, ...color.values] : color.values;

  for (const value of values) {
    const swatch = el('span', 'swatch');
    if (value === null) swatch.classList.add('swatch--none');
    // Set through the style object, never by building CSS text.
    else swatch.style.backgroundColor = value;
    row.append(
      tile({
        group,
        value: value ?? 'none',
        label: value === null ? 'None' : `Colour ${value}`,
        face: swatch,
        checked: value === chosen,
        onChoose: () => update(withColor(current, color, value)),
      }),
    );
  }

  if (color.free) {
    const custom = el('label', 'custom-colour');
    const input = el('input', 'custom-colour__input');
    input.type = 'color';
    input.value = chosen ?? '#ffffff';
    input.addEventListener('input', () => {
      for (const radio of row.querySelectorAll('input[type=radio]')) radio.checked = radio.value === input.value;
      update(withColor(current, color, input.value.toLowerCase()));
    });
    custom.append(input, el('span', 'custom-colour__label', 'Other colour'));
    row.append(custom);
  }

  fieldset.append(row);
  return fieldset;
}

// ---- Changes ------------------------------------------------------------------

// `changedGroup` is the picker that changed, if any; its own thumbnails stay.
function update(avatar, changedGroup) {
  current = avatar;
  drafts.set(current.style, current);
  setNotice(notice, '');
  preview.src = avatarDataUri(current);
  styleImages.get(current.style).src = preview.src;
  showUnsaved();
  redrawThumbnails(changedGroup);
}

function showUnsaved() {
  unsaved.hidden = sameAvatar(current, saved);
}

function replaceAll(avatar) {
  current = avatar;
  drafts.set(current.style, current);
  renderStylePicker();
  renderPartPickers();
  update(current);
}

function chooseStyle(id) {
  replaceAll(drafts.get(id) ?? fromSaved({ seed: current.seed, style: id }));
  // replaceAll() replaced the focused radio; focus its replacement so the arrow keys
  // keep working.
  styleOptions.querySelector(`input[value="${id}"]`).focus();
}

document.getElementById('random-button').addEventListener('click', () => {
  replaceAll(randomChoices(styleInfo(current.style)));
});

document.getElementById('reset-button').addEventListener('click', () => {
  drafts.clear();
  replaceAll({ ...saved });
  setNotice(notice, 'Back to your saved avatar.', 'success');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  try {
    const { user } = await api.put('/api/me/avatar', { avatar: current });
    saved = fromSaved(user.avatar);
    showUnsaved();
    for (const img of document.querySelectorAll('.site-nav img.avatar')) img.src = avatarDataUri(user.avatar);
    setNotice(notice, 'Saved! Other players will see it from your next game.', 'success');
  } catch (err) {
    setNotice(notice, errorMessage(err));
  } finally {
    saveButton.disabled = false;
  }
  notice.focus();
});

// ---- Start ----------------------------------------------------------------------

options = await api.get('/api/avatar/options').catch(() => null);

if (options) {
  saved = fromSaved(me.avatar);
  replaceAll({ ...saved });
  document.getElementById('loading').hidden = true;
  form.hidden = false;
} else {
  document.getElementById('loading').textContent = 'Could not load the avatar builder. Reload the page to try again.';
}
