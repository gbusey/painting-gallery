import { imageURL, loadArtworks } from './data.js';

const article = document.querySelector('#artwork');
const status = document.querySelector('#status');
try {
  const id = new URLSearchParams(location.search).get('id');
  const artworks = await loadArtworks();
  const artwork = artworks.find(item => item.id === id);
  if (!artwork) {
    status.textContent = 'This painting could not be found. Return to the gallery to choose another.';
    document.title = 'Painting not found · Family paintings';
  } else {
    document.title = `${artwork.title} · ${artwork.artist}`;
    const image = document.querySelector('#artwork-image');
    image.alt = artwork.alt;
    image.width = artwork.width;
    image.height = artwork.height;
    image.addEventListener('error', () => {
      status.textContent = 'The painting image could not be loaded.';
    });
    image.src = imageURL(artwork.image);
    document.querySelector('#artwork-title').textContent = artwork.title;
    document.querySelector('#artwork-artist').textContent = artwork.artist;
    const date = document.querySelector('#artwork-date');
    date.dateTime = artwork.date;
    date.textContent = new Intl.DateTimeFormat('en', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
    }).format(new Date(`${artwork.date}T00:00:00Z`));
    article.hidden = false;
  }
} catch (error) {
  status.textContent = 'The artwork details could not be loaded. Please try again later.';
  console.error(error);
} finally {
  article.setAttribute('aria-busy', 'false');
}
