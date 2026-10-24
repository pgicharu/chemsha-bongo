// Helpers shared by the quiz pages. Every option shows a shape and a letter, so
// nothing relies on colour alone.

// Every answer option always shows a shape AND a letter, so nobody has to
// tell the colours apart.
export const OPTION_LETTERS = ['A', 'B', 'C', 'D'];
export const SHAPES = { A: '▲', B: '◆', C: '●', D: '■' };

export const MODE_LABELS = { live: 'Live', self_paced: 'Self-paced' };

// Text always goes in through textContent, never innerHTML, so titles can't inject markup.
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [children].flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function optionMark(letter) {
  return el('span', { className: `option-mark answer--${letter.toLowerCase()}`, 'aria-hidden': 'true' }, `${SHAPES[letter]} ${letter}`);
}

// "Tue 21 Oct 2026, 17:03" in the viewer's own time zone.
export function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function param(name) {
  return new URLSearchParams(window.location.search).get(name);
}

export function shareUrl(slug) {
  return `${window.location.origin}/q/${slug}`;
}
