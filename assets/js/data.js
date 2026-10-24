const dataURL = new URL('../../data/artworks.json', import.meta.url);
const rootURL = new URL('../../', import.meta.url);

export function imageURL(path) {
  return new URL(path, rootURL).href;
}

export function validateArtworks(artworks) {
  if (!Array.isArray(artworks)) throw new Error('Artwork data must be an array.');
  const ids = new Set();
  for (const artwork of artworks) {
    if (!artwork || typeof artwork !== 'object') throw new Error('Invalid artwork entry.');
    for (const field of ['id', 'title', 'artist', 'date', 'alt', 'thumbnail', 'image']) {
      if (typeof artwork[field] !== 'string' || !artwork[field].trim()) {
        throw new Error(`Missing artwork field: ${field}`);
      }
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(artwork.id) || ids.has(artwork.id)) {
      throw new Error(`Invalid or duplicate artwork ID: ${artwork.id}`);
    }
    ids.add(artwork.id);
    const date = new Date(`${artwork.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(artwork.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== artwork.date) {
      throw new Error(`Invalid date for ${artwork.id}`);
    }
    if (![artwork.width, artwork.height].every(value => Number.isInteger(value) && value > 0)) {
      throw new Error(`Invalid image dimensions for ${artwork.id}`);
    }
    for (const field of ['thumbnail', 'image']) {
      const url = new URL(artwork[field], rootURL);
      if (!url.href.startsWith(new URL('assets/artwork/', rootURL).href)) {
        throw new Error(`Image must be inside assets/artwork/: ${artwork.id}`);
      }
    }
  }
  return [...artworks].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export async function loadArtworks() {
  const response = await fetch(dataURL);
  if (!response.ok) throw new Error(`Could not load artwork data (${response.status}).`);
  return validateArtworks(await response.json());
}
