import { imageURL, loadArtworks } from './data.js';

const gallery = document.querySelector('#gallery');
const status = document.querySelector('#status');
const storageKey = `painting-gallery:${new URL('index.html', location.href).pathname}`;
let selectedId;
let savedPosition;
try { savedPosition = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Storage may be unavailable. */ }
selectedId = savedPosition?.id;
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

function savePosition() {
  savedPosition = { y: scrollY, id: selectedId };
  try { sessionStorage.setItem(storageKey, JSON.stringify(savedPosition)); } catch { /* Navigation still works without storage. */ }
}
window.addEventListener('pagehide', savePosition);
window.addEventListener('pageshow', event => {
  if (event.persisted && savedPosition) window.scrollTo(0, savedPosition.y);
});

try {
  const artworks = await loadArtworks();
  const links = artworks.map((artwork, index) => {
    const link = document.createElement('a');
    link.className = 'painting';
    link.href = `artwork.html?id=${encodeURIComponent(artwork.id)}`;
    link.setAttribute('aria-label', `${artwork.title} by ${artwork.artist}`);
    const image = document.createElement('img');
    image.src = imageURL(artwork.thumbnail);
    image.alt = artwork.alt;
    image.width = artwork.width;
    image.height = artwork.height;
    image.loading = index < 6 ? 'eager' : 'lazy';
    image.decoding = 'async';
    link.append(image);
    link.addEventListener('click', () => {
      selectedId = artwork.id;
      savePosition();
    });
    gallery.append(link);
    return link;
  });

  function layout() {
    const width = gallery.clientWidth;
    const spacing = parseFloat(getComputedStyle(gallery).columnGap) || 16;
    const columns = width < 480 ? 2 : Math.max(2, Math.min(5, Math.floor((width + spacing) / (260 + spacing))));
    const columnWidth = (width - spacing * (columns - 1)) / columns;
    const heights = Array(columns).fill(0);
    links.forEach((link, index) => {
      const column = heights.indexOf(Math.min(...heights));
      link.style.width = `${columnWidth}px`;
      link.style.left = `${column * (columnWidth + spacing)}px`;
      link.style.top = `${heights[column]}px`;
      heights[column] += columnWidth * artworks[index].height / artworks[index].width + spacing;
    });
    gallery.style.height = `${Math.max(0, ...heights) - (links.length ? spacing : 0)}px`;
  }
  layout();
  new ResizeObserver(layout).observe(gallery);
  gallery.setAttribute('aria-busy', 'false');
  if (!artworks.length) status.textContent = 'No paintings have been added yet.';
  if (savedPosition && Number.isFinite(savedPosition.y)) {
    const index = artworks.findIndex(artwork => artwork.id === savedPosition.id);
    links[index]?.focus({ preventScroll: true });
    window.scrollTo(0, savedPosition.y);
  }
} catch (error) {
  gallery.setAttribute('aria-busy', 'false');
  status.textContent = 'The gallery could not be loaded. Please try again later.';
  console.error(error);
}
