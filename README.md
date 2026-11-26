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
upload.html                 "Add a painting" page for phones (not linked from the gallery)
assets/css/upload.css       Styles for the upload page
assets/js/upload.js         Upload page: photo picker, crop editor, form
assets/js/upload-image.js   Painting detection, straightening, resizing
assets/js/upload-webp.js    WebP encoding (uses assets/vendor/webp/)
assets/js/upload-github.js  Publishing through the GitHub API
tools/add_painting.py       The same job from a computer's terminal
data/artworks.json          Collection metadata
```

The gallery sorts by creation date, newest first. Equal dates sort by ID for consistency. Artwork is placed into the shortest column in that order. Images retain their proportions and are never cropped. Returning to the gallery in the same tab restores its last scroll position and selected artwork when browser session storage is available.

## Add a painting from your phone

Open the upload page in Safari on your iPhone: the gallery's address followed by `upload.html` (for example `https://<user>.github.io/<repo>/upload.html`). Tap the Share button, then **Add to Home Screen** to open it like an app.

1. Tap **Choose photo** and pick the photo from your library, or take one.
2. The page finds the painting, outlines it in green, and straightens angled photos. Drag the corners to adjust if needed; a magnifier shows exactly where each corner sits. **Whole photo** skips cropping.
3. Tap **Next** to see the result. Enter the title, the date painted, the artist and, optionally, a short description for screen readers.
4. Tap **Publish**. The page saves `full.webp` (2400 px on the long side) and `thumbnail.webp` (800 px), adds the painting to `data/artworks.json`, and commits everything to GitHub in one commit. GitHub Pages redeploys, and the page tells you when the painting is live.

Everything except the final upload happens on the phone; the photo is never sent anywhere else. Camera metadata (including GPS location) is not included in the saved images.

### One-time setup: connect the page to GitHub

The first time, tap **Settings** on the upload page:

1. Create a token at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) (a *fine-grained* token).
2. Under **Repository access**, choose **Only select repositories** and pick this repository.
3. Under **Repository permissions**, set **Contents** to **Read and write**. Nothing else is needed.
4. Generate the token, then paste it into Settings. Check that the repository (`owner/name`) and branch (the one GitHub Pages publishes from, usually `main`) are right, then tap **Save**. The page confirms the connection works.

The token is stored only in that browser on that device, and the page sends it only to GitHub. Because GitHub Pages sites of the same account share one web origin, any other Pages site on your account could read it; keep the token limited to this one repository. If your phone is lost, delete the token on GitHub. When the token expires, create a new one and paste it in Settings.

## Add a painting from a computer

`tools/add_painting.py` does everything in one step: it finds the painting in your photo, crops (and straightens) it, saves `full.webp` (2400 px on the long side) and `thumbnail.webp` (800 px on the long side), adds the entry to `data/artworks.json`, then commits and pushes so GitHub Pages redeploys the gallery.

One-time setup (Python 3.9 or newer):

```sh
python3 -m pip install -r tools/requirements.txt
```

To read iPhone HEIC photos directly, also run `python3 -m pip install pillow-heif`.

Then, from the repository root:

```sh
python3 tools/add_painting.py ~/Pictures/IMG_1234.jpg
```

The tool asks for the title, the date painted (defaults to today), the artist, and an optional short description for screen readers. A preview opens showing the photo with the detected crop outlined in green next to the result. Press `y` to accept it, `o` to try the other crop option (including "no crop"), or `c` to cancel without changing anything.

You can also give everything on the command line:

```sh
python3 tools/add_painting.py photo.jpg --title "Blue Jay" --date 2026-09-12 \
    --artist Sheila --alt "A blue jay sitting on a tree branch."
```

Useful options (see `--help` for all of them):

| Option | What it does |
| --- | --- |
| `--crop-box L,T,R,B` | Crop to exact pixel coordinates when detection gets it wrong |
| `--crop none` | Use the whole photo (e.g. it is already cropped) |
| `--inset 1` | Trim more (in percent) inside the detected edge if a sliver of background remains |
| `--id blue-jay-2` | Choose the URL id; by default it is made from the title |
| `--replace` | Replace an existing painting that has the same id |
| `--no-push` / `--no-commit` | Commit without publishing / only update the files |
| `--yes` | Skip the preview and accept the automatic crop |

Notes:

- For best automatic cropping, photograph the painting against a plain background (wall, table, sheet) that contrasts with its edges. Photos taken at a slight angle are straightened.
- Camera metadata (including GPS location) is removed from the saved images.
- The site redeploys when the commit reaches the branch GitHub Pages publishes from (usually `main`). Before starting, the tool pulls any changes made on github.com. If the push is rejected, it pulls again and retries.

## Add a painting by hand

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

Export thumbnails around 800 pixels on the longest side, and full images around 2400 pixels on the longest side. Scale the other side.
