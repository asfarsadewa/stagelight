"""Cut head portraits out of the finished atlases for the character picker.

Cropping from the sprite sheet rather than generating separate portraits keeps
the picker honest: the face on the chip is literally the face that will appear
on stage, and it cannot drift as the sheets are regenerated.

Boxes are hand-picked per character because the heads cannot be found reliably
by alpha alone — the Comtesse's parasol canopy sits above and beside her head
and merges with her hair into one silhouette.

    python tools/build_heads.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

CELL = 512

# id -> (frame index, left, top, right, bottom) inside that frame's cell
HEADS: dict[str, tuple[int, int, int, int, int]] = {
    "mint": (0, 183, 16, 315, 148),
    "shadow": (0, 178, 26, 310, 158),
    # Her face centres near (268, 132); a sliver of parasol on the left is
    # characterful rather than a mistake, so the box is only nudged off centre.
    "comtesse": (0, 206, 64, 342, 200),
}

OUT_SIZE = 192


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sprites", default="public/sprites")
    ap.add_argument("--size", type=int, default=OUT_SIZE)
    ap.add_argument("--preview", default=".dev-shots/heads.png")
    args = ap.parse_args()

    sprites = Path(args.sprites)
    made = []

    for name, (frame, left, top, right, bottom) in HEADS.items():
        atlas = Image.open(sprites / f"{name}-atlas.webp").convert("RGBA")
        col, row = frame % 4, frame // 4
        cell = atlas.crop((col * CELL, row * CELL, (col + 1) * CELL, (row + 1) * CELL))

        head = cell.crop((left, top, right, bottom))
        # Square it off so the picker can round the corners without cropping a chin.
        side = max(head.width, head.height)
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.alpha_composite(head, ((side - head.width) // 2, (side - head.height) // 2))
        square = square.resize((args.size, args.size), Image.LANCZOS)

        out = sprites / f"{name}-head.webp"
        square.save(out, "WEBP", quality=92, method=6, alpha_quality=100)
        made.append((name, square))
        print(f"{name:9s} -> {out} ({args.size}x{args.size})")

    if args.preview:
        strip = Image.new("RGBA", (args.size * len(made), args.size), (18, 18, 24, 255))
        for i, (_, image) in enumerate(made):
            strip.alpha_composite(image, (i * args.size, 0))
        preview = Path(args.preview)
        preview.parent.mkdir(parents=True, exist_ok=True)
        strip.convert("RGB").save(preview)


if __name__ == "__main__":
    main()
