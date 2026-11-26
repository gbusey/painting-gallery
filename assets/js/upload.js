// The "Add a painting" page: choose a photo, adjust the crop, enter details,
// and publish to GitHub. Image processing lives in upload-image.js, WebP
// encoding in upload-webp.js, and GitHub publishing in upload-github.js.

import { detectPainting, outputSize, resizeLongSide, warp, wholeImage } from './upload-image.js';
import { encodeWebP, loadEncoder } from './upload-webp.js';
import { GitHub, guessRepository, slugify } from './upload-github.js';

const FULL_LONG_SIDE = 2400;
const THUMB_LONG_SIDE = 800;
const QUALITY = 90;
const INSET = 0.005;              // trim 0.5% inside the outline so no background shows
const MAX_SIDE = 4096;            // decode limit; plenty for a 2400 px result,
const MAX_PIXELS = 16_000_000;    // and within iPhone canvas memory limits
const SETTINGS_KEY = 'painting-upload:settings';
const ARTIST_KEY = 'painting-upload:artist';
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const $ = selector => document.querySelector(selector);
const steps = ['#step-pick', '#step-crop', '#step-details', '#step-done'];

const state = {
  photo: null,     // { canvas, pixels } of the decoded photo
  corners: null,   // [TL, TR, BR, BL] in photo pixels
  detected: null,  // result of auto-detection
  result: null,    // { full, thumb, fullBytes, thumbBytes, previewURL }
  idEdited: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function show(step) {
  for (const id of steps) $(id).hidden = id !== step;
  window.scrollTo(0, 0);
}

function busy(text) {
  $('#busy').hidden = !text;
  $('#busy-text').textContent = text || '';
}

// Let the browser draw (e.g. the busy indicator) before heavy work.
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

function today() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  updateSetupNotice();
}

function github() {
  const { token, repository, branch } = loadSettings();
  if (!token || !repository) return null;
  return new GitHub({ token, repository, branch: branch || 'main' });
}

function updateSetupNotice() {
  $('#setup-notice').hidden = Boolean(github());
}

// ---------------------------------------------------------------------------
// Step 1: load the photo
// ---------------------------------------------------------------------------

async function decodePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode(); // Browsers apply the photo's rotation (EXIF orientation).
    const { naturalWidth: w, naturalHeight: h } = image;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { canvas, pixels: context.getImageData(0, 0, canvas.width, canvas.height) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('#photo-input').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = ''; // allow choosing the same photo again later
  if (!file) return;
  busy('Opening photo…');
  try {
    await nextFrame();
    if (state.photo) state.photo.canvas.width = 0; // free memory from the previous photo
    state.photo = await decodePhoto(file);
    busy('Finding the painting…');
    await nextFrame();
    state.detected = detectPainting(state.photo.pixels);
    state.corners = state.detected.corners.map(c => [...c]);
    $('#crop-hint').textContent = state.detected.found
      ? 'Found the painting. Drag the corners to adjust, then tap Next.'
      : 'Couldn’t find clear edges, so the whole photo is selected. Drag the corners onto the painting’s corners.';
    show('#step-crop');
    layoutStage();
    loadEncoder().catch(() => {}); // warm up while the crop is adjusted
  } catch (error) {
    console.error(error);
    alert('That photo couldn’t be opened. Try another photo, or a JPEG or PNG file.');
  } finally {
    busy();
  }
});

// ---------------------------------------------------------------------------
// Step 2: crop editor
// ---------------------------------------------------------------------------

const stage = $('#crop-stage');
const cropCanvas = $('#crop-canvas');
const overlay = $('#crop-overlay');
const loupe = $('#loupe');
const cornerNames = ['top left', 'top right', 'bottom right', 'bottom left'];
const handles = cornerNames.map((name, index) => {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'handle';
  handle.setAttribute('aria-label', `Move ${name} corner (arrow keys)`);
  handle.addEventListener('pointerdown', event => startDrag(event, index));
  handle.addEventListener('keydown', event => nudge(event, index));
  stage.append(handle);
  return handle;
});
let displayScale = 1; // CSS pixels per photo pixel

function layoutStage() {
  if (!state.photo || $('#step-crop').hidden) return;
  const { width, height } = state.photo.canvas;
  const available = stage.parentElement.clientWidth;
  const maxHeight = Math.max(240, window.innerHeight * 0.62);
  displayScale = Math.min(available / width, maxHeight / height);
  const cssWidth = Math.round(width * displayScale);
  const cssHeight = Math.round(height * displayScale);
  stage.style.width = `${cssWidth}px`;
  stage.style.height = `${cssHeight}px`;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  cropCanvas.width = Math.round(cssWidth * ratio);
  cropCanvas.height = Math.round(cssHeight * ratio);
  const context = cropCanvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(state.photo.canvas, 0, 0, cropCanvas.width, cropCanvas.height);
  overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
  drawCrop();
}

function drawCrop() {
  const { width, height } = state.photo.canvas;
  const points = state.corners.map(([x, y]) => `${x},${y}`).join(' ');
  $('#crop-outline').setAttribute('points', points);
  $('#crop-shade').setAttribute('d', `M0,0H${width}V${height}H0Z M${state.corners.map(([x, y]) => `${x},${y}`).join(' L')}Z`);
  state.corners.forEach(([x, y], i) => {
    handles[i].style.left = `${x * displayScale}px`;
    handles[i].style.top = `${y * displayScale}px`;
  });
}

function clampPoint([x, y]) {
  const { width, height } = state.photo.canvas;
  return [Math.min(width, Math.max(0, x)), Math.min(height, Math.max(0, y))];
}

// The corner moves with the finger's motion rather than jumping under it, so it
// stays visible; the magnifier shows exactly where it is.
function startDrag(event, index) {
  event.preventDefault();
  const handle = handles[index];
  handle.setPointerCapture(event.pointerId);
  const start = { x: event.clientX, y: event.clientY, corner: [...state.corners[index]] };
  const move = moveEvent => {
    const dx = (moveEvent.clientX - start.x) / displayScale;
    const dy = (moveEvent.clientY - start.y) / displayScale;
    state.corners[index] = clampPoint([start.corner[0] + dx, start.corner[1] + dy]);
    drawCrop();
    drawLoupe(index);
  };
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    loupe.hidden = true;
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  drawLoupe(index);
}

function nudge(event, index) {
  const step = (event.shiftKey ? 10 : 1) / displayScale;
  const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  if (!delta) return;
  event.preventDefault();
  const [x, y] = state.corners[index];
  state.corners[index] = clampPoint([x + delta[0], y + delta[1]]);
  drawCrop();
}

function drawLoupe(index) {
  const zoom = 4; // relative to the on-screen photo
  const size = loupe.width;
  const cssSize = loupe.offsetWidth || 140;
  const [cx, cy] = state.corners[index];
  const span = cssSize / zoom / displayScale; // photo pixels shown across the loupe
  const toLoupe = ([x, y]) => [((x - cx) / span + 0.5) * size, ((y - cy) / span + 0.5) * size];
  const context = loupe.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, size, size);
  context.imageSmoothingQuality = 'high';
  // Clip the source rectangle to the photo (Safari draws nothing if it overhangs).
  const { width: pw, height: ph } = state.photo.canvas;
  const sx = Math.max(0, cx - span / 2), sy = Math.max(0, cy - span / 2);
  const ex = Math.min(pw, cx + span / 2), ey = Math.min(ph, cy + span / 2);
  if (ex > sx && ey > sy) {
    const [dx, dy] = toLoupe([sx, sy]);
    const [dx2, dy2] = toLoupe([ex, ey]);
    context.drawImage(state.photo.canvas, sx, sy, ex - sx, ey - sy, dx, dy, dx2 - dx, dy2 - dy);
  }
  context.strokeStyle = '#7CFC9A';
  context.lineWidth = 3;
  context.beginPath();
  state.corners.forEach((corner, i) => {
    const [x, y] = toLoupe(corner);
    if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.closePath();
  context.stroke();
  context.strokeStyle = 'rgba(255,255,255,0.9)';
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(size / 2, size / 2 - 18); context.lineTo(size / 2, size / 2 + 18);
  context.moveTo(size / 2 - 18, size / 2); context.lineTo(size / 2 + 18, size / 2);
  context.stroke();
  // Keep the loupe away from the corner being dragged.
  loupe.classList.toggle('right', cx < pw / 2);
  loupe.classList.toggle('bottom', cy < ph * 0.35);
  loupe.hidden = false;
}

window.addEventListener('resize', layoutStage);

$('#auto-button').addEventListener('click', () => {
  state.corners = state.detected.corners.map(c => [...c]);
  $('#crop-hint').textContent = state.detected.found
    ? 'Back to the automatic crop.'
    : 'Couldn’t find clear edges automatically; drag the corners onto the painting.';
  drawCrop();
});

$('#whole-button').addEventListener('click', () => {
  state.corners = wholeImage(state.photo.canvas);
  $('#crop-hint').textContent = 'Using the whole photo.';
  drawCrop();
});

$('#crop-back').addEventListener('click', () => $('#photo-input').click());

$('#crop-next').addEventListener('click', async () => {
  busy('Cropping and resizing…');
  try {
    await nextFrame();
    const { pixels } = state.photo;
    const whole = state.corners.every((c, i) => c[0] === wholeImage(pixels)[i][0] && c[1] === wholeImage(pixels)[i][1]);
    const inset = whole ? 0 : INSET;
    const size = outputSize(state.corners, inset, FULL_LONG_SIDE);
    const full = warp(pixels, state.corners, size.width, size.height, inset);
    const thumb = resizeLongSide(full, THUMB_LONG_SIDE);
    busy('Saving as WebP…');
    await nextFrame();
    const [fullBytes, thumbBytes] = [await toWebP(full), await toWebP(thumb)];
    if (state.result?.previewURL) URL.revokeObjectURL(state.result.previewURL);
    const previewURL = URL.createObjectURL(new Blob([fullBytes], { type: 'image/webp' }));
    state.result = { full, thumb, fullBytes, thumbBytes, previewURL };
    $('#result-preview').src = previewURL;
    const sizeNote = Math.max(full.width, full.height) < FULL_LONG_SIDE
      ? ` The painting is smaller than ${FULL_LONG_SIDE} px in this photo, so it wasn’t enlarged.`
      : '';
    $('#result-info').textContent = `${full.width} × ${full.height} px (${Math.round(fullBytes.length / 1024)} KB).${sizeNote}`;
    prepareForm();
    show('#step-details');
  } catch (error) {
    console.error(error);
    alert(`Something went wrong while processing the photo: ${error.message}`);
  } finally {
    busy();
  }
});

async function toWebP(image) {
  try {
    return await encodeWebP(image, QUALITY);
  } catch (error) {
    // Fall back to the browser's own encoder where it supports WebP.
    console.warn('WebAssembly WebP encoder unavailable', error);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', QUALITY / 100));
    canvas.width = 0;
    if (!blob || blob.type !== 'image/webp') throw new Error('This browser can’t create WebP images.');
    return new Uint8Array(await blob.arrayBuffer());
  }
}

// ---------------------------------------------------------------------------
// Step 3: details
// ---------------------------------------------------------------------------

let artistsLoaded = false;
async function loadArtists() {
  if (artistsLoaded) return;
  artistsLoaded = true;
  try {
    const response = await fetch('data/artworks.json', { cache: 'no-cache' });
    const artworks = await response.json();
    const artists = [...new Set(artworks.map(a => a.artist).filter(Boolean))].sort();
    $('#artists').replaceChildren(...artists.map(name => Object.assign(document.createElement('option'), { value: name })));
  } catch { /* Suggestions are optional. */ }
}

function prepareForm() {
  loadArtists();
  if (!$('#date').value) $('#date').value = today();
  if (!$('#artist').value) $('#artist').value = localStorage.getItem(ARTIST_KEY) || '';
  $('#form-error').textContent = '';
}

$('#title').addEventListener('input', () => {
  if (!state.idEdited) $('#artwork-id').value = slugify($('#title').value);
});
$('#artwork-id').addEventListener('input', () => { state.idEdited = $('#artwork-id').value.trim() !== ''; });
$('#details-back').addEventListener('click', () => { show('#step-crop'); layoutStage(); });

function readForm() {
  const title = $('#title').value.trim();
  const date = $('#date').value;
  const artist = $('#artist').value.trim();
  const id = ($('#artwork-id').value.trim() || slugify(title));
  if (!title) return { error: 'Please enter a title.', field: '#title' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Please choose the date it was painted.', field: '#date' };
  if (!artist) return { error: 'Please enter the artist.', field: '#artist' };
  if (!ID_PATTERN.test(id)) {
    $('#details-form details').open = true;
    return { error: 'The page id can only use lowercase letters, numbers and hyphens (e.g. blue-jay).', field: '#artwork-id' };
  }
  const alt = $('#alt').value.trim() || `${title}, a painting by ${artist}.`;
  const { full } = state.result;
  return {
    entry: {
      id, title, artist, date, alt,
      width: full.width,
      height: full.height,
      thumbnail: `assets/artwork/${id}/thumbnail.webp`,
      image: `assets/artwork/${id}/full.webp`,
    },
    replace: $('#replace').checked,
  };
}

$('#details-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = readForm();
  if (form.error) {
    $('#form-error').textContent = form.error;
    $(form.field).focus();
    return;
  }
  if (!github()) {
    $('#form-error').textContent = 'Connect to GitHub first (Settings).';
    openSettings();
    return;
  }
  publish(form);
});

// ---------------------------------------------------------------------------
// Step 4: publish
// ---------------------------------------------------------------------------

let lastForm = null;

async function publish(form) {
  lastForm = form;
  const { entry, replace } = form;
  show('#step-done');
  $('#publish-error').textContent = '';
  $('#done-actions').hidden = true;
  $('#retry-actions').hidden = true;
  $('#commit-link').hidden = true;
  const status = $('#publish-status');
  try {
    const api = github();
    const { url } = await api.publish({
      entry,
      replace,
      message: `${replace ? 'Update' : 'Add'} painting: ${entry.title}`,
      images: [
        { path: entry.image, bytes: state.result.fullBytes },
        { path: entry.thumbnail, bytes: state.result.thumbBytes },
      ],
      onProgress: text => { status.textContent = text; },
    });
    localStorage.setItem(ARTIST_KEY, entry.artist);
    $('#commit-link').href = url;
    $('#commit-link').hidden = false;
    $('#done-actions').hidden = false;
    status.textContent = `Published “${entry.title}”. The gallery updates in a minute or two…`;
    waitUntilLive(entry.id, status, entry.title);
  } catch (error) {
    console.error(error);
    status.textContent = 'Not published.';
    $('#publish-error').textContent = error.message;
    $('#retry-actions').hidden = false;
  }
}

// GitHub Pages takes a minute or two to redeploy; check until the painting appears.
async function waitUntilLive(id, status, title) {
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    if ($('#step-done').hidden) return;
    try {
      const response = await fetch(`data/artworks.json?check=${Date.now()}`, { cache: 'no-store' });
      const artworks = await response.json();
      if (artworks.some(a => a.id === id)) {
        status.textContent = `“${title}” is live in the gallery.`;
        return;
      }
    } catch { /* keep waiting */ }
  }
  status.textContent = `Published “${title}”. It hasn’t appeared yet; GitHub Pages can take a few minutes.`;
}

$('#retry-button').addEventListener('click', () => lastForm && publish(lastForm));
$('#retry-back').addEventListener('click', () => show('#step-details'));
$('#another-button').addEventListener('click', () => {
  for (const id of ['#title', '#alt', '#artwork-id']) $(id).value = '';
  $('#replace').checked = false;
  state.idEdited = false;
  show('#step-pick');
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const dialog = $('#settings');

function openSettings() {
  const settings = loadSettings();
  $('#token').value = settings.token || '';
  $('#repository').value = settings.repository || guessRepository(location);
  $('#branch').value = settings.branch || 'main';
  $('#settings-status').textContent = '';
  dialog.showModal();
}

$('#settings-button').addEventListener('click', openSettings);
$('#setup-button').addEventListener('click', openSettings);
$('#settings-cancel').addEventListener('click', () => dialog.close());

$('#settings-save').addEventListener('click', async () => {
  const settings = {
    token: $('#token').value.trim(),
    repository: $('#repository').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''),
    branch: $('#branch').value.trim() || 'main',
  };
  const status = $('#settings-status');
  if (!settings.token || !/^[\w.-]+\/[\w.-]+$/.test(settings.repository)) {
    status.textContent = 'Enter a token and the repository as owner/name.';
    return;
  }
  status.textContent = 'Checking…';
  try {
    await new GitHub(settings).check();
    saveSettings(settings);
    status.textContent = `Connected to ${settings.repository} (${settings.branch}).`;
    setTimeout(() => dialog.close(), 900);
  } catch (error) {
    status.textContent = error.message;
  }
});

$('#forget-button').addEventListener('click', () => {
  const settings = loadSettings();
  delete settings.token;
  saveSettings(settings);
  $('#token').value = '';
  $('#settings-status').textContent = 'Token removed from this device.';
});

updateSetupNotice();
