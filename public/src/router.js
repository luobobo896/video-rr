import { reactive } from 'vue';

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  return {
    path: path || '/',
    query: Object.fromEntries(new URLSearchParams(search))
  };
}

export const route = reactive(parseHash());

function syncRoute() {
  Object.assign(route, parseHash());
  window.scrollTo({ top: 0, behavior: 'auto' });
}

window.addEventListener('hashchange', syncRoute);

export function go(path) {
  const next = path.startsWith('#') ? path.slice(1) : path;
  if (window.location.hash === `#${next}`) return;
  window.location.hash = next;
}

export function href(path) {
  return `#${path}`;
}
