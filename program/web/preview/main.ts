import { installPreview } from './transport';

installPreview();
const base = location.pathname;
for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method].bind(history);
  history[method] = (data, unused, url) => {
    const next = new URL(String(url ?? location.href), location.href);
    original(data, unused, `${base}${next.search}${next.hash}`);
  };
}
document.addEventListener('click', event => {
  const anchor = (event.target as Element).closest('a');
  if (!anchor) return;
  event.preventDefault();
  const url = new URL(anchor.href, location.href);
  if (url.searchParams.has('view')) {
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }
}, true);
const style = document.createElement('style');
style.textContent = '.app-shell{height:calc(100dvh - 44px)!important;min-height:0!important}';
document.head.appendChild(style);
await import('../src/main');
