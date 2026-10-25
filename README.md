# Family Painting Gallery

A static, responsive masonry gallery with individual artwork pages. Plain HTML, CSS, JavaScript, and JSON; no build step or backend.

## Preview locally

From the repository root, run:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. Use an HTTP server rather than opening HTML files directly: browsers need HTTP to load the JSON and JavaScript modules. Stop the server with Ctrl+C.

## Organization

```text
index.html                  Main gallery (artwork only)
artwork.html                Reusable detail page: artwork.html?id=blue-vase
assets/css/styles.css       Shared theme and layout
assets/js/data.js           JSON loading, validation, sorting
assets/js/gallery.js        Masonry layout and scroll restoration
assets/js/artwork.js        Detail page rendering
assets/artwork/<id>/        Thumbnail and full image for each painting
data/artworks.json          Collection metadata
```

The gallery sorts by creation date, newest first. Equal dates sort by ID for consistency. Artwork is placed into the shortest column in that order. Images retain their proportions and are never cropped. Returning to the gallery in the same tab restores its last scroll position and selected artwork when browser session storage is available.

## Add a painting

1. Choose a unique, stable lowercase ID with hyphens, such as `blue-vase`. Avoid changing IDs after publication so shared links keep working.
2. Create `assets/artwork/blue-vase/` with `thumbnail.webp` and `full.webp`. JPEG and PNG also work.
3. Add an object to `data/artworks.json`:

```json
{
  "id": "blue-vase",
  "title": "Blue Vase",
  "artist": "Artist Name",
  "date": "2026-10-24",
  "alt": "A blue ceramic vase holding yellow flowers on a wooden table.",
  "width": 1600,
  "height": 1200,
  "thumbnail": "assets/artwork/blue-vase/thumbnail.webp",
  "image": "assets/artwork/blue-vase/full.webp"
}
```

Use a complete creation date in `YYYY-MM-DD` format. `width` and `height` are the full image's pixel dimensions after correcting its orientation. The thumbnail must have the same proportions. Write a short visual description in `alt`; title and artist are already provided to assistive technology by the artwork link.

Export thumbnails around 800 pixels wide, and full images around 2000–2400 pixels on the longest side. Adjust these to balance detail and download size. Keep original camera files outside the published repo. All published files are public.
