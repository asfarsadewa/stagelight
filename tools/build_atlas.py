"""Slice the keyed dancer sheet into a fixed-cell atlas.

Unlike the generic companion normaliser this keeps ONE global scale for every
frame, so a crouch really reads as shorter than a standing pose instead of being
blown up to fill its cell. Frames are anchored on the feet (median x of the
bottom slice of the silhouette) so she stays planted centre-stage while arms
swing wide.

    python tools/build_atlas.py \
        --input assets-src/dancer-keyed.png \
        --out public/sprites/dancer-atlas.png \
        --meta public/sprites/dancer-atlas.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image

COLUMNS = 4
ROWS = 3
ALPHA_THRESHOLD = 16


def despeckle(img: Image.Image, min_area: int = 400) -> Image.Image:
    """Drop tiny disconnected alpha blobs left behind by the chroma key.

    They are invisible on the source sheet but show up clearly once the sprite
    is composited over a dark stage, as flecks hanging in mid-air.
    """
    alpha = img.getchannel("A")
    w, h = alpha.size
    px = alpha.load()
    seen = bytearray(w * h)
    doomed: list[tuple[int, int]] = []

    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if seen[i] or px[sx, sy] <= ALPHA_THRESHOLD:
                continue
            # Iterative flood fill; recursion would blow the stack on a big blob.
            stack = [(sx, sy)]
            seen[i] = 1
            blob = []
            while stack:
                x, y = stack.pop()
                blob.append((x, y))
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and px[nx, ny] > ALPHA_THRESHOLD:
                            seen[j] = 1
                            stack.append((nx, ny))
            if len(blob) < min_area:
                doomed.extend(blob)

    if doomed:
        for x, y in doomed:
            px[x, y] = 0
        img.putalpha(alpha)
    return img


def alpha_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = img.getchannel("A").point(lambda v: 255 if v > ALPHA_THRESHOLD else 0)
    return alpha.getbbox()


def foot_anchor_x(img: Image.Image, bbox: tuple[int, int, int, int]) -> float:
    """Horizontal centre of the lowest 18% of the silhouette (the feet)."""
    left, top, right, bottom = bbox
    height = bottom - top
    slice_top = bottom - max(2, int(height * 0.18))
    region = img.crop((left, slice_top, right, bottom)).getchannel("A")
    px = region.load()
    w, h = region.size
    xs_min, xs_max = w, -1
    for y in range(h):
        for x in range(w):
            if px[x, y] > ALPHA_THRESHOLD:
                if x < xs_min:
                    xs_min = x
                if x > xs_max:
                    xs_max = x
    if xs_max < 0:
        return (left + right) / 2
    return left + (xs_min + xs_max) / 2


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--cell-size", type=int, default=512)
    ap.add_argument("--preview", help="Optional dark-background contact sheet.")
    # Fraction of the cell height the tallest pose should occupy.
    ap.add_argument("--fill", type=float, default=0.92)
    args = ap.parse_args()

    sheet = Image.open(args.input).convert("RGBA")
    src_w = sheet.width // COLUMNS
    src_h = sheet.height // ROWS

    frames = []
    for row in range(ROWS):
        for col in range(COLUMNS):
            cell = despeckle(sheet.crop((col * src_w, row * src_h, (col + 1) * src_w, (row + 1) * src_h)))
            bbox = alpha_bbox(cell)
            if bbox is None:
                raise SystemExit(f"frame {row * COLUMNS + col} is empty — check the chroma key")
            frames.append((cell, bbox, foot_anchor_x(cell, bbox)))

    tallest = max(b[3] - b[1] for _, b, _ in frames)
    cell = args.cell_size
    scale = (cell * args.fill) / tallest
    baseline = int(cell * 0.97)  # where the feet sit inside the cell

    atlas = Image.new("RGBA", (cell * COLUMNS, cell * ROWS), (0, 0, 0, 0))
    meta_frames = []

    for i, (img, bbox, anchor_x) in enumerate(frames):
        left, top, right, bottom = bbox
        cropped = img.crop(bbox)
        w = max(1, round((right - left) * scale))
        h = max(1, round((bottom - top) * scale))
        cropped = cropped.resize((w, h), Image.LANCZOS)

        col, row = i % COLUMNS, i // COLUMNS
        # Keep the foot anchor at the cell's horizontal centre.
        anchor_in_crop = (anchor_x - left) * scale
        x = col * cell + round(cell / 2 - anchor_in_crop)
        y = row * cell + baseline - h
        atlas.alpha_composite(cropped, (x, y))

        meta_frames.append({
            "index": i,
            # Normalised height of this pose relative to the tallest one; the
            # renderer uses it only for diagnostics, the art is already scaled.
            "relativeHeight": round(h / (cell * args.fill), 4),
        })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(out)

    meta = {
        "image": out.name,
        "columns": COLUMNS,
        "rows": ROWS,
        "frameCount": len(frames),
        "cellSize": cell,
        "baseline": baseline / cell,
        "frames": meta_frames,
    }
    Path(args.meta).write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    if args.preview:
        bg = Image.new("RGBA", atlas.size, (18, 18, 22, 255))
        bg.alpha_composite(atlas)
        bg.convert("RGB").save(args.preview)

    print(f"atlas={out} cells={COLUMNS}x{ROWS} cell={cell} scale={scale:.4f}")


if __name__ == "__main__":
    main()
