// Image processing for the upload page: find the painting in a photo, straighten
// and crop it, and resize it. Everything works on plain RGBA pixel buffers
// ({ width, height, data: Uint8ClampedArray }, like ImageData), so it runs the
// same in the browser and in tests.

// Detection settings (overridable for testing via detectPainting's options).
const DEFAULTS = {
  longSide: 800,          // detection runs on a downscaled copy for speed
  lightness: 2.5,         // weights of lightness and colour in colour differences
  colour: 2.5,
  edgeThreshold: 12,      // colour difference that counts as an edge
  minSupport: 0.7,        // fraction of a side that must lie on an edge
  borderSupport: 0.7,     // a real edge must beat this to be cropped along
  areaWeight: 0.3,        // preference for keeping more of the photo
  candidates: 6,          // candidate lines kept per side
};

/** Area-averaging resize (high quality for downscaling). */
export function resize(image, width, height) {
  const { width: sw, height: sh, data } = image;
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  const columns = weights(sw, width);
  const rows = weights(sh, height);
  // Horizontal pass into floats, then vertical pass.
  const temp = new Float32Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    const rowIn = y * sw * 4;
    const rowOut = y * width * 4;
    for (let x = 0; x < width; x++) {
      const { start, w } = columns[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const i = rowIn + (start + k) * 4;
        const wk = w[k];
        r += data[i] * wk; g += data[i + 1] * wk; b += data[i + 2] * wk; a += data[i + 3] * wk;
      }
      const o = rowOut + x * 4;
      temp[o] = r; temp[o + 1] = g; temp[o + 2] = b; temp[o + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const { start, w } = rows[y];
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const i = ((start + k) * width + x) * 4;
        const wk = w[k];
        r += temp[i] * wk; g += temp[i + 1] * wk; b += temp[i + 2] * wk; a += temp[i + 3] * wk;
      }
      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}

// For each output pixel, the source pixels it covers and how much of each.
function weights(sourceSize, targetSize) {
  const scale = sourceSize / targetSize;
  const result = [];
  for (let i = 0; i < targetSize; i++) {
    let from = i * scale;
    let to = (i + 1) * scale;
    if (scale < 1) { // Enlarging: just take the nearest pixel.
      const nearest = Math.min(sourceSize - 1, Math.floor((i + 0.5) * scale));
      result.push({ start: nearest, w: [1] });
      continue;
    }
    const start = Math.floor(from);
    const end = Math.min(sourceSize, Math.ceil(to));
    const w = [];
    for (let s = start; s < end; s++) w.push((Math.min(to, s + 1) - Math.max(from, s)) / scale);
    result.push({ start, w });
  }
  return result;
}

export function resizeLongSide(image, longSide) {
  const scale = Math.min(1, longSide / Math.max(image.width, image.height));
  if (scale === 1) return image;
  return resize(image, image.width * scale, image.height * scale);
}

// ---------------------------------------------------------------------------
// Painting detection
// ---------------------------------------------------------------------------

const srgbToLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** CIE Lab, with colour weighted double so hue-only edges count too. */
function weightedLab({ width, height, data }, lightness = 1, colour = 2) {
  const out = new Float32Array(width * height * 3);
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const r = srgbToLinear[data[i]], g = srgbToLinear[data[i + 1]], b = srgbToLinear[data[i + 2]];
    const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    out[p * 3] = lightness * (116 * fy - 16);
    out[p * 3 + 1] = colour * 500 * (fx - fy);
    out[p * 3 + 2] = colour * 200 * (fy - fz);
  }
  return out;
}

function blur3(values, width, height) {
  const kernel = [0.054, 0.244, 0.404, 0.244, 0.054];
  const temp = new Float32Array(values.length);
  const out = new Float32Array(values.length);
  const pass = (src, dst, dx, dy) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = -2; k <= 2; k++) {
            const xx = Math.min(width - 1, Math.max(0, x + k * dx));
            const yy = Math.min(height - 1, Math.max(0, y + k * dy));
            sum += src[(yy * width + xx) * 3 + c] * kernel[k + 2];
          }
          dst[(y * width + x) * 3 + c] = sum;
        }
      }
    }
  };
  pass(values, temp, 1, 0);
  pass(temp, out, 0, 1);
  return out;
}

/** Colour difference between pixels `offset` px either side, horizontally or vertically. */
function contrastMap(lab, width, height, horizontal, offset = 2) {
  const out = new Float32Array(width * height);
  const step = horizontal ? offset : offset * width;
  for (let y = horizontal ? 0 : offset; y < (horizontal ? height : height - offset); y++) {
    for (let x = horizontal ? offset : 0; x < (horizontal ? width - offset : width); x++) {
      const p = y * width + x;
      const a = (p - step) * 3, b = (p + step) * 3;
      out[p] = Math.hypot(lab[a] - lab[b], lab[a + 1] - lab[b + 1], lab[a + 2] - lab[b + 2]);
    }
  }
  return out;
}

/**
 * 1 where the contrast is above `threshold` and the strongest within 6 px
 * across the line direction, widened by 1 px either side to allow for rounding.
 */
function ridgeMap(map, width, height, horizontal, threshold, radius = 6) {
  const peaks = new Uint8Array(width * height);
  const step = horizontal ? 1 : width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const value = map[p];
      if (value <= threshold) continue;
      const pos = horizontal ? x : y, size = horizontal ? width : height;
      let peak = true;
      for (let k = -radius; k <= radius && peak; k++) {
        if (k === 0 || pos + k < 0 || pos + k >= size) continue;
        const other = map[p + k * step];
        if (other > value || (other === value && k < 0)) peak = false;
      }
      if (peak) {
        peaks[p] = 1;
        if (pos > 0) peaks[p - step] = 1;
        if (pos < size - 1) peaks[p + step] = 1;
      }
    }
  }
  return peaks;
}

// A side line runs between two points on opposite borders of the photo:
// vertical sides from (top, 0) to (bottom, height-1); horizontal sides from
// (0, left) to (width-1, right).
function sideCandidates(map, width, height, vertical, near, { edgeThreshold, candidates } = DEFAULTS) {
  const across = vertical ? width : height;  // the direction the side can move in
  const along = vertical ? height : width;
  const maxTilt = Math.round(across * 0.12);
  const from = near ? 0 : Math.round(across * 0.55);
  const to = near ? Math.round(across * 0.45) : across - 1;
  const step = 3;
  const results = [];
  for (let a = from; a <= to; a++) {
    for (let d = -maxTilt; d <= maxTilt; d++) {
      const b = a + d;
      if (b < from || b > to) continue;
      let hits = 0, total = 0;
      for (let t = 0; t < along; t += step) {
        const pos = Math.round(a + (d * t) / (along - 1));
        const value = vertical ? map[t * width + pos] : map[pos * width + t];
        total++;
        if (value) hits++;
      }
      results.push({ a, b, support: hits / total });
    }
  }
  results.sort((p, q) => q.support - p.support);
  const picked = [];
  for (const line of results) {
    if (line.support < 0.08) break;
    if (picked.some(p => Math.abs(p.a - line.a) <= 4 && Math.abs(p.b - line.b) <= 4)) continue;
    picked.push(line);
    if (picked.length === candidates) break;
  }
  const edge = near ? 0 : across - 1;
  picked.push({ a: edge, b: edge, border: true });
  return picked.map(line => (vertical
    ? { ...line, p: [line.a, 0], q: [line.b, height - 1] }
    : { ...line, p: [0, line.a], q: [width - 1, line.b] }));
}

function intersect(l1, l2) {
  const [x1, y1] = l1.p, [x2, y2] = l1.q, [x3, y3] = l2.p, [x4, y4] = l2.q;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

function segmentSupport(map, width, height, start, end, edgeThreshold = DEFAULTS.edgeThreshold) {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const count = Math.max(8, Math.round(length / 2));
  let hits = 0, total = 0;
  for (let i = 0; i < count; i++) {
    const t = 0.03 + (0.94 * i) / (count - 1);
    const x = Math.round(start[0] + t * (end[0] - start[0]));
    const y = Math.round(start[1] + t * (end[1] - start[1]));
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    total++;
    if (map[y * width + x]) hits++;
  }
  return total ? hits / total : 0;
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/** Convex, roughly square corners (allowing for perspective), and big enough. */
export function plausibleQuad(corners, width, height, minArea = 0.15) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross === 0 || (sign && Math.sign(cross) !== sign)) return false;
    sign = Math.sign(cross);
    const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v));
    if (Math.abs(cos) > Math.cos((65 * Math.PI) / 180)) return false;
  }
  return polygonArea(corners) >= minArea * width * height;
}

/**
 * Find the painting in a photo.
 * Returns { corners: [TL, TR, BR, BL] in image pixels, found: boolean }.
 * When nothing convincing is found, the corners are the whole image.
 */
export function detectPainting(image, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const scale = Math.min(1, o.longSide / Math.max(image.width, image.height));
  const small = scale < 1 ? resize(image, image.width * scale, image.height * scale) : image;
  const { width, height } = small;
  const lab = blur3(weightedLab(small, o.lightness, o.colour), width, height);
  const fine = { across: contrastMap(lab, width, height, true), down: contrastMap(lab, width, height, false) };
  // A point supports a side only where the colour change peaks right on the
  // line. Along a real painting edge it does so the whole way; in texture
  // (brush strokes, foliage, wood grain) the peaks are scattered.
  const across = ridgeMap(fine.across, width, height, true, o.edgeThreshold);  // for vertical sides
  const down = ridgeMap(fine.down, width, height, false, o.edgeThreshold);     // for horizontal sides

  const left = sideCandidates(across, width, height, true, true, o);
  const right = sideCandidates(across, width, height, true, false, o);
  const top = sideCandidates(down, width, height, false, true, o);
  const bottom = sideCandidates(down, width, height, false, false, o);

  // Try every combination and keep the one whose four sides are all real edges
  // (between its own corners), preferring larger outlines on ties.
  let best = null;
  for (const l of left) for (const r of right) for (const t of top) for (const b of bottom) {
    if (l.border && r.border && t.border && b.border) continue;
    const corners = [intersect(l, t), intersect(r, t), intersect(r, b), intersect(l, b)];
    if (corners.some(c => !c || c[0] < -2 || c[1] < -2 || c[0] > width + 1 || c[1] > height + 1)) continue;
    if (!plausibleQuad(corners, width, height)) continue;
    const sides = [[t, 0, 1, down], [r, 1, 2, across], [b, 2, 3, down], [l, 3, 0, across]];
    let total = 0, valid = true;
    for (const [line, i, j, map] of sides) {
      const support = line.border ? o.borderSupport : segmentSupport(map, width, height, corners[i], corners[j], o.edgeThreshold);
      if (!line.border && support < o.minSupport) { valid = false; break; }
      total += support;
    }
    if (!valid) continue;
    const score = total / 4 + o.areaWeight * (polygonArea(corners) / (width * height));
    if (!best || score > best.score) best = { score, corners, lines: [t, r, b, l] };
  }

  const full = wholeImage(image);
  if (!best) return { corners: full, found: false };
  const refined = refine(best.lines, fine, width, height);
  const corners = refined.map(([x, y]) => [
    Math.min(image.width, Math.max(0, x / scale)),
    Math.min(image.height, Math.max(0, y / scale)),
  ]);
  // Snap sides that sit on the photo's border exactly to it.
  const snapped = snapToBorder(corners, image.width, image.height);
  const found = polygonArea(snapped) < 0.995 * image.width * image.height;
  return { corners: found ? snapped : full, found };
}

// Nudge each detected side (up to 4 px, either end independently) to where the
// fine edge map is strongest, then recompute the corners.
function refine([top, right, bottom, left], fine, width, height) {
  const lines = [top, right, bottom, left].map((line, index) => {
    if (line.border) return line;
    const vertical = index % 2 === 1;
    const map = vertical ? fine.across : fine.down;
    const move = (point, delta) => (vertical ? [point[0] + delta, point[1]] : [point[0], point[1] + delta]);
    let best = line, bestScore = -1;
    for (let dp = -4; dp <= 4; dp += 0.5) {
      for (let dq = -4; dq <= 4; dq += 0.5) {
        const candidate = { p: move(line.p, dp), q: move(line.q, dq) };
        const score = meanAlong(map, width, height, candidate.p, candidate.q);
        if (score > bestScore) { best = candidate; bestScore = score; }
      }
    }
    return best;
  });
  const [t, r, b, l] = lines;
  return [intersect(l, t), intersect(r, t), intersect(r, b), intersect(l, b)];
}

function meanAlong(map, width, height, start, end) {
  let sum = 0, total = 0;
  const count = Math.max(8, Math.round(Math.hypot(end[0] - start[0], end[1] - start[1]) / 2));
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const x = Math.round(start[0] + t * (end[0] - start[0]));
    const y = Math.round(start[1] + t * (end[1] - start[1]));
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    sum += map[y * width + x];
    total++;
  }
  return total ? sum / total : 0;
}

export function wholeImage({ width, height }) {
  return [[0, 0], [width, 0], [width, height], [0, height]];
}

function snapToBorder(corners, width, height) {
  const tolerance = 0.004 * Math.max(width, height);
  return corners.map(([x, y]) => [
    x < tolerance ? 0 : x > width - tolerance ? width : x,
    y < tolerance ? 0 : y > height - tolerance ? height : y,
  ]);
}

// ---------------------------------------------------------------------------
// Straighten and crop
// ---------------------------------------------------------------------------

/** Pixel size of the straightened painting, limited to `maxLongSide`. */
export function outputSize(corners, inset = 0, maxLongSide = Infinity) {
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const [tl, tr, br, bl] = corners;
  const width = Math.max(d(tl, tr), d(bl, br)) * (1 - 2 * inset);
  const height = Math.max(d(tl, bl), d(tr, br)) * (1 - 2 * inset);
  const scale = Math.min(1, maxLongSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Projective map from the unit square to the quad (TL, TR, BR, BL).
function squareToQuad([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w];
  };
}

/**
 * Cut the quad out of the image as an upright rectangle of the given size.
 * `inset` trims that fraction from each side so no background peeks through.
 */
export function warp(image, corners, width, height, inset = 0) {
  const map = squareToQuad(corners);
  const { width: sw, height: sh, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  // Average several samples per pixel when shrinking, to avoid jagged detail.
  const source = outputSize(corners, inset);
  const ss = Math.min(3, Math.max(1, Math.ceil(Math.max(source.width / width, source.height / height))));
  const span = 1 - 2 * inset;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        const v = inset + ((y + (sy + 0.5) / ss) / height) * span;
        for (let sx = 0; sx < ss; sx++) {
          const u = inset + ((x + (sx + 0.5) / ss) / width) * span;
          let [px, py] = map(u, v);
          px = Math.min(sw - 1, Math.max(0, px - 0.5));
          py = Math.min(sh - 1, Math.max(0, py - 0.5));
          const x0 = Math.floor(px), y0 = Math.floor(py);
          const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
          const fx = px - x0, fy = py - y0;
          const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          r += data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
          g += data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
          b += data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
        }
      }
      const n = ss * ss;
      const o = (y * width + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
