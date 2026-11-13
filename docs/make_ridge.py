#!/usr/bin/env python3
"""Draw docs/images/ridge.png, the dithered mountain ridge in the header.

Two ridges of a mountain forest, the yellow tit's habitat, as a one-bit
picture: the far ridge is a light dither, the near ridge darkens towards the
bottom and carries a row of conifers. Every curve repeats with the image
width, so the picture tiles across a wide screen without a seam. The page
shows each pixel as a 2 by 2 CSS pixel block.

    python3 docs/make_ridge.py      needs Pillow; writes the PNG
"""

import math
import pathlib
import random

from PIL import Image, ImageDraw

W, H = 800, 96
NAVY = (0x22, 0x30, 0x5E)
OUT = pathlib.Path(__file__).resolve().parent / "images" / "ridge.png"

# (cycles per image width, amplitude in pixels, phase): integer cycles keep
# every ridge periodic over W
FAR = [(1, 7, 0.3), (2, 5, 1.7), (5, 2.5, 0.2), (11, 1.2, 2.0)]
NEAR = [(1, 6, 2.1), (3, 5, 0.4), (7, 2.2, 1.1), (13, 1.0, 0.7)]


def ridge(x, base, waves):
    return base + sum(
        a * math.sin(2 * math.pi * k * x / W + p) for k, a, p in waves
    )


def main():
    grey = Image.new("L", (W, H), 255)
    px = grey.load()
    for x in range(W):
        far, near = ridge(x, 42, FAR), ridge(x, 66, NEAR)
        for y in range(H):
            ink = 0.0
            if y >= far:
                ink = 0.2
            if y >= near:
                ink = 0.48 + 0.4 * (y - near) / (H - near)
            px[x, y] = round(255 * (1 - min(ink, 1.0)))
    draw = ImageDraw.Draw(grey)
    rng = random.Random(7)
    x = 0.0
    while x < W:
        h = rng.randint(6, 13)
        half = h * 0.42
        foot = ridge(x, 66, NEAR) + 2
        for shift in (-W, 0, W):  # a tree on the seam is drawn on both sides
            cx = x + shift
            draw.polygon(
                [(cx, foot - h), (cx - half, foot), (cx + half, foot)],
                fill=0,
            )
        x += rng.randint(7, 19)
    one_bit = grey.convert("1")  # Floyd-Steinberg error diffusion
    out = Image.new("P", (W, H), 0)
    out.putpalette([255, 255, 255, *NAVY])
    src, dst = one_bit.load(), out.load()
    for x in range(W):
        for y in range(H):
            dst[x, y] = 0 if src[x, y] else 1
    out.save(OUT, transparency=0, bits=1, optimize=True)
    print(f"{OUT}: {W} x {H}, {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
