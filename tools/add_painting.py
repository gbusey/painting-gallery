#!/usr/bin/env python3
"""Add a painting to the gallery in one step.

Given a photo of a painting, this tool:
  1. finds the painting in the photo and crops (and straightens) it,
  2. saves full.webp (2400 px long side) and thumbnail.webp (800 px long side)
     in assets/artwork/<id>/,
  3. adds an entry to data/artworks.json,
  4. commits and pushes the change so GitHub Pages redeploys the site.

Examples:
  python3 tools/add_painting.py ~/Photos/IMG_1234.jpg
  python3 tools/add_painting.py photo.jpg --title "Blue Jay" --date 2026-09-12 \\
      --artist Sheila --alt "A blue jay sitting on a branch."

Anything not given on the command line is asked for interactively.
Run with --help to see every option.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

try:
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw, ImageOps
except ImportError as error:  # pragma: no cover - depends on the user's machine
    sys.exit(
        f"Missing Python package ({error.name}). Install the tool's requirements with:\n"
        f"  python3 -m pip install -r {Path(__file__).with_name('requirements.txt')}"
    )

try:  # Optional: read iPhone HEIC/HEIF photos.
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = REPO_ROOT / "data" / "artworks.json"
ARTWORK_DIR = REPO_ROOT / "assets" / "artwork"

FULL_LONG_SIDE = 2400
THUMB_LONG_SIDE = 800
DETECT_LONG_SIDE = 1200  # Painting detection runs on a downscaled copy for speed.
ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


# --------------------------------------------------------------------------- #
# Painting detection
# --------------------------------------------------------------------------- #

@dataclass
class Crop:
    """A candidate crop: four corners (TL, TR, BR, BL) in full-image pixels."""

    method: str
    corners: np.ndarray | None  # None means "use the whole image"

    def describe(self) -> str:
        return {
            "edges": "painting outline found from its edges",
            "background": "background trimmed from the sides",
            "none": "no crop (whole photo)",
            "manual": "manual crop box",
        }[self.method]


def order_corners(points: np.ndarray) -> np.ndarray:
    """Return four points ordered top-left, top-right, bottom-right, bottom-left."""
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    sums = points.sum(axis=1)
    diffs = np.diff(points, axis=1).ravel()  # y - x
    return np.array(
        [
            points[np.argmin(sums)],
            points[np.argmin(diffs)],
            points[np.argmax(sums)],
            points[np.argmax(diffs)],
        ],
        dtype=np.float32,
    )


def plausible_quad(quad: np.ndarray, width: int, height: int, min_area: float) -> bool:
    """Is this quadrilateral a believable photo of a rectangular painting?"""
    quad = order_corners(quad)
    if len({tuple(p) for p in quad.round(1)}) != 4:
        return False
    if not cv2.isContourConvex(quad.reshape(-1, 1, 2)):
        return False
    area = cv2.contourArea(quad)
    if area < min_area * width * height or area > 0.995 * width * height:
        return False
    sides = [np.linalg.norm(quad[(i + 1) % 4] - quad[i]) for i in range(4)]
    if min(sides) < 0.1 * max(width, height):
        return False
    # Opposite sides should be similar (allowing for some perspective).
    if min(sides[0], sides[2]) / max(sides[0], sides[2]) < 0.7:
        return False
    if min(sides[1], sides[3]) / max(sides[1], sides[3]) < 0.7:
        return False
    # Corners should be roughly square.
    for i in range(4):
        a = quad[i - 1] - quad[i]
        b = quad[(i + 1) % 4] - quad[i]
        cos = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
        if abs(cos) > np.cos(np.radians(65)):  # angle outside 65°..115°
            return False
    return True


def quad_from_contour(contour: np.ndarray, width: int, height: int, min_area: float):
    """Fit a quadrilateral to a contour; return it only if it fits well."""
    hull = cv2.convexHull(contour)
    hull_area = cv2.contourArea(hull)
    if hull_area < min_area * width * height:
        return None
    perimeter = cv2.arcLength(hull, True)
    for epsilon in (0.01, 0.02, 0.03, 0.04, 0.06):
        approx = cv2.approxPolyDP(hull, epsilon * perimeter, True)
        if len(approx) == 4:
            break
    else:
        return None
    quad = approx.reshape(4, 2).astype(np.float32)
    quad_area = cv2.contourArea(quad)
    # The quad must hug the shape: no big bulges in or out.
    if quad_area <= 0 or not 0.92 <= hull_area / quad_area <= 1.08:
        return None
    if not plausible_quad(quad, width, height, min_area):
        return None
    return order_corners(quad)


def detect_by_edges(small: np.ndarray) -> np.ndarray | None:
    """Find the painting's outline as the largest well-formed quadrilateral of edges."""
    height, width = small.shape[:2]
    # Detect edges in brightness and in colour separately: a painting can be as
    # bright as the wall behind it and differ only in hue.
    lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB)
    channels = [lab[:, :, 0]] + [
        cv2.convertScaleAbs(lab[:, :, i].astype(np.float32) - 128, alpha=2.5, beta=128) for i in (1, 2)
    ]
    # Brightness gets an edge-preserving blur to hide paint texture; colour only a light one.
    channels[0] = cv2.bilateralFilter(channels[0], 9, 50, 50)
    channels[1:] = [cv2.GaussianBlur(c, (3, 3), 0) for c in channels[1:]]
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edge_maps = []
    for low, high in ((20, 60), (40, 120), (75, 200)):
        combined = np.zeros((height, width), np.uint8)
        for channel in channels:
            combined |= cv2.Canny(channel, low, high)
        edge_maps.append(combined)

    candidates = []
    # 1) Closed outlines traced directly from the edge map.
    for edges in edge_maps:
        contours, _ = cv2.findContours(cv2.dilate(edges, kernel, iterations=2), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            quad = quad_from_contour(contour, width, height, min_area=0.2)
            if quad is not None:
                candidates.append(quad)
    # 2) Rectangles assembled from long straight lines. This still works when the
    #    outline touches other edges, e.g. the line of a table the painting stands on.
    candidates.extend(quads_from_lines(edge_maps[0], width, height))

    # Score each candidate by the colour contrast across its four sides. A real
    # painting outline separates two different regions along its whole length;
    # random texture (wood grain, carpet) does not.
    contrast_image = make_contrast_image(small)
    best, best_score = None, 0.0
    for quad in candidates:
        support = [side_contrast(contrast_image, quad[i], quad[(i + 1) % 4])[0] for i in range(4)]
        if min(support) < 0.6:
            continue
        score = cv2.contourArea(quad) / (width * height) * float(np.mean(support)) ** 2
        if score > best_score:
            best, best_score = quad, score
    return None if best is None else refine_quad(contrast_image, best)


def make_contrast_image(small: np.ndarray) -> np.ndarray:
    """Lightly blurred Lab image, colour weighted up, for measuring contrast."""
    lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB).astype(np.float32)
    return cv2.GaussianBlur(lab, (0, 0), 1.5) * np.float32([1, 2, 2])


def side_contrast(image: np.ndarray, start: np.ndarray, end: np.ndarray, offset: float = 4.0,
                  threshold: float = 12.0) -> tuple[float, float]:
    """Contrast across the segment start→end.

    Returns (fraction of points with a clear colour change across the line,
    mean colour difference). Corners are skipped.
    """
    height, width = image.shape[:2]
    direction = end - start
    length = float(np.linalg.norm(direction))
    if length < 1:
        return 0.0, 0.0
    normal = np.array([-direction[1], direction[0]]) / length
    t = np.linspace(0.05, 0.95, max(8, int(length / 2)))[:, None]
    points = start + t * direction
    a = (points + normal * offset).round().astype(int)
    b = (points - normal * offset).round().astype(int)
    inside = ((a >= 0) & (a < [width, height]) & (b >= 0) & (b < [width, height])).all(axis=1)
    if inside.mean() < 0.95:
        return 0.0, 0.0
    a, b = a[inside], b[inside]
    diff = np.linalg.norm(image[a[:, 1], a[:, 0]] - image[b[:, 1], b[:, 0]], axis=1)
    return float((diff > threshold).mean()), float(diff.mean())


def refine_quad(image: np.ndarray, quad: np.ndarray, search: int = 6, fixed: frozenset = frozenset()) -> np.ndarray:
    """Nudge each side a few pixels to where the colour change across it is strongest.

    Sides listed in `fixed` (indices 0-3: top, right, bottom, left) stay put.
    """
    lines = []
    for i in range(4):
        start, end = quad[i], quad[(i + 1) % 4]
        if i in fixed:
            lines.append((start, end))
            continue
        direction = end - start
        normal = np.array([-direction[1], direction[0]]) / np.linalg.norm(direction)
        best_shift = max(
            range(-search, search + 1),
            key=lambda d: side_contrast(image, start + normal * d, end + normal * d, offset=2.0)[1],
        )
        lines.append((start + normal * best_shift, end + normal * best_shift))

    def intersect(line1, line2):
        (p, p2), (q, q2) = line1, line2
        r, s = p2 - p, q2 - q
        denominator = r[0] * s[1] - r[1] * s[0]
        if abs(denominator) < 1e-9:
            return None
        t = ((q - p)[0] * s[1] - (q - p)[1] * s[0]) / denominator
        return p + t * r

    corners = [intersect(lines[i - 1], lines[i]) for i in range(4)]
    if any(c is None for c in corners):
        return quad
    refined = np.array(corners, dtype=np.float32)
    return refined if np.abs(refined - quad).max() <= 2 * search else quad


def quads_from_lines(edges: np.ndarray, width: int, height: int, per_group: int = 12) -> list[np.ndarray]:
    """Combine pairs of near-horizontal and near-vertical lines into quadrilaterals."""
    segments = cv2.HoughLinesP(
        edges, 1, np.pi / 360, threshold=60, minLineLength=int(0.12 * min(width, height)), maxLineGap=8
    )
    if segments is None:
        return []
    diagonal = float(np.hypot(width, height))
    groups: dict[str, list[tuple[float, float]]] = {"h": [], "v": []}
    for x1, y1, x2, y2 in sorted(segments.reshape(-1, 4).astype(float), key=lambda s: -np.hypot(s[2] - s[0], s[3] - s[1])):
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1)) % 180
        if angle < 30 or angle > 150:
            group = groups["h"]
        elif 60 < angle < 120:
            group = groups["v"]
        else:
            continue
        # Normal form: x*cos(theta) + y*sin(theta) = rho.
        theta = np.radians(angle + 90)
        rho = x1 * np.cos(theta) + y1 * np.sin(theta)
        if rho < 0:
            theta, rho = theta - np.pi, -rho
        duplicate = any(
            abs(np.sin(theta - t)) < np.sin(np.radians(3)) and abs(rho - r) < 0.01 * diagonal for t, r in group
        )
        if not duplicate and len(group) < per_group:
            group.append((theta, rho))

    def intersect(a, b):
        matrix = np.array([[np.cos(a[0]), np.sin(a[0])], [np.cos(b[0]), np.sin(b[0])]])
        if abs(np.linalg.det(matrix)) < 1e-6:
            return None
        return np.linalg.solve(matrix, [a[1], b[1]])

    quads = []
    h_lines, v_lines = groups["h"], groups["v"]
    for i, top in enumerate(h_lines):
        for bottom in h_lines[i + 1:]:
            for j, left in enumerate(v_lines):
                for right in v_lines[j + 1:]:
                    points = [intersect(top, left), intersect(top, right), intersect(bottom, right), intersect(bottom, left)]
                    if any(p is None for p in points):
                        continue
                    quad = np.array(points, dtype=np.float32)
                    if plausible_quad(quad, width, height, min_area=0.2):
                        quads.append(order_corners(quad))
    return quads


def detect_by_background(small: np.ndarray) -> np.ndarray | None:
    """Trim plain background (wall, table, paper) from the edges of the photo.

    Each side of the photo whose outer strip is a fairly uniform colour is
    treated as background. Everything that is not close to one of those
    background colours is the painting. Works even when the painting touches
    some edges of the photo (e.g. only the left and right sides need cropping).
    """
    height, width = small.shape[:2]
    lab = cv2.cvtColor(cv2.GaussianBlur(small, (5, 5), 0), cv2.COLOR_RGB2LAB).astype(np.float32)
    strip = max(3, round(0.015 * min(width, height)))
    sides = [lab[:strip], lab[-strip:], lab[:, :strip], lab[:, -strip:]]

    backgrounds = []
    for pixels in sides:
        pixels = pixels.reshape(-1, 3)
        median = np.median(pixels, axis=0)
        spread = np.median(np.linalg.norm(pixels - median, axis=1))
        if spread < 6:  # uniform enough to be background
            backgrounds.append((median, spread))
    if not backgrounds:
        return None

    foreground = np.ones((height, width), dtype=bool)
    for color, spread in backgrounds:
        threshold = max(14.0, 4 * spread)
        foreground &= np.linalg.norm(lab - color, axis=2) > threshold
    mask = foreground.astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=3)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    if count <= 1:
        return None
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, w, h = stats[largest, :4]
    if w * h < 0.2 * width * height or w * h > 0.995 * width * height:
        return None

    component = (labels == largest).astype(np.uint8) * 255
    contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv2.contourArea)
    quad = quad_from_contour(contour, width, height, min_area=0.2)
    if quad is None:
        # Not a clean quadrilateral (e.g. painting runs off an edge): use its bounding box.
        quad = np.array([[x, y], [x + w - 1, y], [x + w - 1, y + h - 1], [x, y + h - 1]], dtype=np.float32)

    # Every side we cut along must be a sharp edge along its whole length. This
    # stops a plain area *inside* the painting (sky, a flat backdrop) that
    # happens to reach the photo's edge from being mistaken for background.
    contrast = make_contrast_image(small)
    margin = 3
    border_sides = set()
    for i in range(4):
        start, end = quad[i], quad[(i + 1) % 4]
        ends = np.array([start, end])
        on_border = (
            (ends[:, 0] <= margin).all() or (ends[:, 0] >= width - 1 - margin).all()
            or (ends[:, 1] <= margin).all() or (ends[:, 1] >= height - 1 - margin).all()
        )
        if on_border:
            border_sides.add(i)
            continue
        if side_contrast(contrast, start, end)[0] < 0.6:
            return None
    if len(border_sides) == 4:
        return None
    return refine_quad(contrast, quad, fixed=frozenset(border_sides))


def find_crops(image: Image.Image) -> list[Crop]:
    """Return candidate crops, best guess first, always ending with 'no crop'."""
    scale = min(1.0, DETECT_LONG_SIDE / max(image.size))
    small_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    small = np.asarray(image.resize(small_size, Image.Resampling.BILINEAR))

    candidates = []
    for method, detector in (("edges", detect_by_edges), ("background", detect_by_background)):
        quad = detector(small)
        if quad is None:
            continue
        corners = quad / scale
        # Skip a candidate that duplicates an earlier one.
        if any(np.abs(c.corners - corners).max() < 0.01 * max(image.size) for c in candidates):
            continue
        candidates.append(Crop(method, corners))
    candidates.append(Crop("none", None))
    return candidates


def apply_crop(image: Image.Image, crop: Crop, inset: float) -> Image.Image:
    """Cut out the cropped region, straightening it if it was photographed at an angle."""
    if crop.corners is None:
        return image
    tl, tr, br, bl = crop.corners
    width = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    height = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    # Trim a hair inside the outline so no background or canvas edge peeks through.
    dx, dy = width * inset, height * inset

    left, top = crop.corners.min(axis=0)
    right, bottom = crop.corners.max(axis=0)
    axis_aligned = np.abs(crop.corners - [[left, top], [right, top], [right, bottom], [left, bottom]]).max()
    if axis_aligned <= 0.003 * max(image.size):
        box = (left + dx, top + dy, right - dx, bottom - dy)
        box = tuple(int(round(v)) for v in box)
        box = (max(0, box[0]), max(0, box[1]), min(image.width, box[2]), min(image.height, box[3]))
        return image.crop(box)

    out_w, out_h = int(round(width - 2 * dx)), int(round(height - 2 * dy))
    target = np.array(
        [[-dx, -dy], [width - dx - 1, -dy], [width - dx - 1, height - dy - 1], [-dx, height - dy - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(crop.corners.astype(np.float32), target)
    warped = cv2.warpPerspective(
        np.asarray(image), matrix, (out_w, out_h), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE
    )
    return Image.fromarray(warped)


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #

def load_image(path: Path) -> tuple[Image.Image, bytes | None]:
    """Open a photo upright (honouring camera rotation) as RGB, plus its colour profile."""
    try:
        image = Image.open(path)
    except Exception as error:
        if path.suffix.lower() in {".heic", ".heif"}:
            sys.exit("To read HEIC photos, first run:  python3 -m pip install pillow-heif")
        sys.exit(f"Could not open {path}: {error}")
    icc_profile = image.info.get("icc_profile")
    image = ImageOps.exif_transpose(image)
    if image.mode != "RGB":
        background = Image.new("RGB", image.size, "white")
        rgba = image.convert("RGBA")
        background.paste(rgba, mask=rgba.getchannel("A"))
        image = background
    return image, icc_profile


def resize_long_side(image: Image.Image, long_side: int) -> Image.Image:
    scale = long_side / max(image.size)
    if scale >= 1:
        return image.copy()
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS)


def build_preview(original: Image.Image, crop: Crop, result: Image.Image) -> Image.Image:
    """Side-by-side preview: the photo with the crop outlined, and the cropped result."""
    height = 900
    left = resize_long_side(original, 10_000)
    scale = height / left.height
    left = left.resize((max(1, round(left.width * scale)), height), Image.Resampling.LANCZOS)
    if crop.corners is not None:
        draw = ImageDraw.Draw(left)
        points = [tuple(p * scale) for p in crop.corners]
        draw.line(points + [points[0]], fill=(0, 255, 0), width=5)
    right = result.resize(
        (max(1, round(result.width * height / result.height)), height), Image.Resampling.LANCZOS
    )
    gap = 24
    canvas = Image.new("RGB", (left.width + gap + right.width, height), (40, 40, 40))
    canvas.paste(left, (0, 0))
    canvas.paste(right, (left.width + gap, 0))
    return canvas


def save_webp(image: Image.Image, path: Path, quality: int, icc_profile: bytes | None) -> None:
    # EXIF (including any GPS location) is intentionally not copied.
    options = {"quality": quality, "method": 6}
    if icc_profile:
        options["icc_profile"] = icc_profile
    image.save(path, "WEBP", **options)


# --------------------------------------------------------------------------- #
# Metadata and prompts
# --------------------------------------------------------------------------- #

def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"['’]", "", text.lower())
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def valid_date(value: str) -> str:
    value = value.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            dt.date.fromisoformat(value)
            return value
    except ValueError:
        pass
    raise argparse.ArgumentTypeError(f"'{value}' is not a valid date; use YYYY-MM-DD, e.g. 2026-10-24")


def interactive() -> bool:
    return sys.stdin.isatty()


def ask(question: str, default: str | None = None, validate=None) -> str:
    if not interactive():
        sys.exit(f"Missing required value: {question} (pass it as an option; see --help)")
    suffix = f" [{default}]" if default else ""
    while True:
        answer = input(f"{question}{suffix}: ").strip() or (default or "")
        if not answer:
            print("  Please enter a value.")
            continue
        if validate:
            try:
                return validate(answer)
            except (ValueError, argparse.ArgumentTypeError) as error:
                print(f"  {error}")
                continue
        return answer


def confirm(question: str, default: bool = True) -> bool:
    if not interactive():
        return default
    hint = "Y/n" if default else "y/N"
    answer = input(f"{question} [{hint}]: ").strip().lower()
    return default if not answer else answer.startswith("y")


def load_artworks() -> list[dict]:
    with DATA_FILE.open(encoding="utf-8") as file:
        artworks = json.load(file)
    if not isinstance(artworks, list):
        sys.exit(f"{DATA_FILE} should contain a JSON list.")
    return artworks


def write_artworks(artworks: list[dict]) -> None:
    text = json.dumps(artworks, indent=2, ensure_ascii=False) + "\n"
    DATA_FILE.write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------- #
# Git
# --------------------------------------------------------------------------- #

def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=REPO_ROOT, text=True, capture_output=True, check=check)


def has_upstream() -> bool:
    return git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", check=False).returncode == 0


def sync_before_changes() -> None:
    """Fetch commits made elsewhere (e.g. on github.com) so the JSON is up to date."""
    if not has_upstream():
        return
    result = git("pull", "--ff-only", check=False)
    if result.returncode != 0:
        print("Note: could not update from GitHub first (offline, or local commits differ):")
        print("  " + (result.stderr.strip() or result.stdout.strip()).replace("\n", "\n  "))


def commit_and_push(paths: list[Path], message: str, push: bool) -> None:
    relative = [str(p.relative_to(REPO_ROOT)) for p in paths]
    git("add", "--", *relative)
    result = git("commit", "-m", message, "--", *relative, check=False)
    if result.returncode != 0:
        sys.exit("git commit failed:\n" + (result.stderr or result.stdout))
    print(f"Committed: {message}")
    if not push:
        print("Not pushed (--no-push). Run 'git push' when you are ready to publish.")
        return

    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    push_args = ["push"] if has_upstream() else ["push", "-u", "origin", "HEAD"]
    result = git(*push_args, check=False)
    if result.returncode != 0 and has_upstream():
        # Someone pushed in the meantime (e.g. an upload on github.com): replay on top and retry.
        print("Push was rejected; pulling the latest changes and retrying...")
        pull = git("pull", "--rebase", "--autostash", check=False)
        if pull.returncode != 0:
            git("rebase", "--abort", check=False)
            sys.exit(
                "Could not merge with the latest changes on GitHub. Your commit is saved locally.\n"
                "Resolve with 'git pull --rebase', then 'git push'.\n" + pull.stderr
            )
        result = git("push", check=False)
    if result.returncode != 0:
        sys.exit(
            "git push failed. Your commit is saved locally; run 'git push' to publish it.\n"
            + (result.stderr or result.stdout)
        )
    print(f"Pushed to GitHub (branch '{branch}').")
    if branch not in {"main", "master", "gh-pages"}:
        print(
            f"Note: GitHub Pages only redeploys once this reaches the branch it publishes from "
            f"(usually 'main'). You are on '{branch}'."
        )
    else:
        print("GitHub Pages will redeploy the gallery in a minute or two.")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Crop, resize, and publish a new painting to the gallery.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Example:\n  python3 tools/add_painting.py photo.jpg --title \"Blue Jay\" --date 2026-09-12",
    )
    parser.add_argument("image", type=Path, help="photo or scan of the painting (JPEG, PNG, WebP, ...)")
    parser.add_argument("--title", help="painting title, e.g. 'Blue Jay'")
    parser.add_argument("--date", type=valid_date, help="date painted, YYYY-MM-DD")
    parser.add_argument("--artist", help="artist's name")
    parser.add_argument("--alt", help="short visual description for screen readers")
    parser.add_argument("--id", dest="artwork_id", help="URL id (default: made from the title)")
    parser.add_argument(
        "--crop",
        choices=["auto", "edges", "background", "none"],
        default="auto",
        help="how to find the painting: auto (default), edges (outline detection, also "
        "straightens angled photos), background (trim plain background), none",
    )
    parser.add_argument(
        "--crop-box",
        metavar="LEFT,TOP,RIGHT,BOTTOM",
        help="crop to exact pixel coordinates of the (upright) photo instead of detecting",
    )
    parser.add_argument(
        "--inset",
        type=float,
        default=0.5,
        help="extra percent trimmed inside the detected outline (default: 0.5)",
    )
    parser.add_argument("--quality", type=int, default=90, help="WebP quality 1-100 (default: 90)")
    parser.add_argument("--replace", action="store_true", help="replace an existing painting with this id")
    parser.add_argument("--yes", "-y", action="store_true", help="accept the crop without showing a preview")
    parser.add_argument("--no-commit", action="store_true", help="update files only; don't commit or push")
    parser.add_argument("--no-push", action="store_true", help="commit but don't push")
    return parser.parse_args(argv)


def choose_crop(args: argparse.Namespace, image: Image.Image) -> tuple[Crop, Image.Image]:
    inset = max(0.0, args.inset) / 100
    if args.crop_box:
        try:
            left, top, right, bottom = (float(v) for v in args.crop_box.split(","))
        except ValueError:
            sys.exit("--crop-box must look like LEFT,TOP,RIGHT,BOTTOM, e.g. 120,0,2900,4032")
        if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
            sys.exit(f"--crop-box is outside the photo, which is {image.width}x{image.height} pixels.")
        corners = np.array([[left, top], [right, top], [right, bottom], [left, bottom]], np.float32)
        candidates = [Crop("manual", corners)]
        inset = 0.0
    elif args.crop == "none":
        candidates = [Crop("none", None)]
    else:
        print("Looking for the painting in the photo...")
        candidates = find_crops(image)
        if args.crop != "auto":
            preferred = [c for c in candidates if c.method == args.crop]
            if not preferred:
                print(f"The '{args.crop}' method could not find the painting.")
            candidates = preferred + [c for c in candidates if c.method != args.crop]

    index = 0
    while True:
        crop = candidates[index]
        result = apply_crop(image, crop, inset)
        print(f"Crop: {crop.describe()} -> {result.width}x{result.height} px")
        if args.yes or not interactive():
            return crop, result

        preview = build_preview(image, crop, result)
        preview_path = Path(tempfile.gettempdir()) / "painting-crop-preview.jpg"
        preview.save(preview_path, quality=88)
        print("Opening preview (left: photo with the crop outlined in green, right: result).")
        print(f"  If no window appears, open {preview_path}")
        try:
            preview.show(title="Crop preview")
        except Exception:
            pass

        options = "[y] use this crop"
        if len(candidates) > 1:
            options += ", [o] try the other option"
        options += ", [c] cancel"
        answer = input(f"{options}: ").strip().lower() or "y"
        if answer.startswith("y"):
            return crop, result
        if answer.startswith("o") and len(candidates) > 1:
            index = (index + 1) % len(candidates)
            continue
        if answer.startswith("c") or answer.startswith("q"):
            sys.exit(
                "Cancelled; nothing was changed. Tip: use --crop-box LEFT,TOP,RIGHT,BOTTOM to crop exactly."
            )


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if not args.image.is_file():
        sys.exit(f"File not found: {args.image}")
    if not 1 <= args.quality <= 100:
        sys.exit("--quality must be between 1 and 100.")

    if not args.no_commit:
        sync_before_changes()
        pending = git("status", "--porcelain", "--", str(DATA_FILE.relative_to(REPO_ROOT))).stdout.strip()
        if pending and not confirm(
            f"{DATA_FILE.relative_to(REPO_ROOT)} has uncommitted edits that will be included in this commit. Continue?",
            default=False,
        ):
            sys.exit("Cancelled; nothing was changed.")
    artworks = load_artworks()
    existing_ids = {a.get("id") for a in artworks}

    # --- Metadata ---------------------------------------------------------
    title = args.title or ask("Title")
    artwork_id = args.artwork_id or slugify(title)
    if not ID_PATTERN.fullmatch(artwork_id or ""):
        if args.artwork_id or not interactive():
            sys.exit(f"Invalid id '{artwork_id}'. Use lowercase letters, numbers and hyphens, e.g. blue-vase.")
        artwork_id = ask("URL id (lowercase letters, numbers, hyphens)", validate=lambda v: _check_id(v))
    if artwork_id in existing_ids and not args.replace:
        sys.exit(
            f"A painting with id '{artwork_id}' already exists. "
            "Choose another with --id, or use --replace to overwrite it."
        )
    date = args.date or ask("Date painted (YYYY-MM-DD)", dt.date.today().isoformat(), valid_date)
    known_artists = sorted({a.get("artist") for a in artworks if a.get("artist")})
    artist = args.artist or ask("Artist" + (f" ({', '.join(known_artists)})" if known_artists else ""))
    if args.alt:
        alt = args.alt
    elif interactive():
        alt = input("Short description of the image for screen readers (optional): ").strip()
        alt = alt or f"{title}, a painting by {artist}."
    else:
        alt = f"{title}, a painting by {artist}."

    # --- Images -----------------------------------------------------------
    image, icc_profile = load_image(args.image)
    print(f"Photo: {image.width}x{image.height} px")
    _, cropped = choose_crop(args, image)

    full = resize_long_side(cropped, FULL_LONG_SIDE)
    thumbnail = resize_long_side(full, THUMB_LONG_SIDE)
    if max(full.size) < FULL_LONG_SIDE:
        print(f"Note: the cropped painting is only {max(full.size)} px on its long side, so it was not enlarged.")

    folder = ARTWORK_DIR / artwork_id
    folder.mkdir(parents=True, exist_ok=True)
    full_path, thumb_path = folder / "full.webp", folder / "thumbnail.webp"
    save_webp(full, full_path, args.quality, icc_profile)
    save_webp(thumbnail, thumb_path, args.quality, icc_profile)
    print(f"Saved {full_path.relative_to(REPO_ROOT)} ({full.width}x{full.height})")
    print(f"Saved {thumb_path.relative_to(REPO_ROOT)} ({thumbnail.width}x{thumbnail.height})")

    # --- JSON -------------------------------------------------------------
    entry = {
        "id": artwork_id,
        "title": title,
        "artist": artist,
        "date": date,
        "alt": alt,
        "width": full.width,
        "height": full.height,
        "thumbnail": f"assets/artwork/{artwork_id}/thumbnail.webp",
        "image": f"assets/artwork/{artwork_id}/full.webp",
    }
    replaced = False
    for i, artwork in enumerate(artworks):
        if artwork.get("id") == artwork_id:
            artworks[i] = entry
            replaced = True
    if not replaced:
        artworks.insert(0, entry)
    write_artworks(artworks)
    print(f"{'Updated' if replaced else 'Added'} '{title}' in {DATA_FILE.relative_to(REPO_ROOT)}")

    # --- Publish ----------------------------------------------------------
    if args.no_commit:
        print("Files updated; not committed (--no-commit).")
        return
    message = f"{'Update' if replaced else 'Add'} painting: {title}"
    commit_and_push([full_path, thumb_path, DATA_FILE], message, push=not args.no_push)


def _check_id(value: str) -> str:
    if not ID_PATTERN.fullmatch(value):
        raise ValueError("Use lowercase letters, numbers and hyphens, e.g. blue-vase.")
    return value


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCancelled.")
