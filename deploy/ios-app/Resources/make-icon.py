#!/usr/bin/env python3
"""
Draw the app icon: a lowercase Georgia "b" on the site's accent colour.

Lowercase because the site's nav is lowercase ("today", "work", "people");
Georgia because it is on every Mac and reads as a word, not a logo. The colour
is --accent from web/style.css.

iOS wants one 1024px square and rounds it itself. macOS wants ten sizes and
does NOT round them, so those get the rounded-square shape with the ~10%
margin Apple's template uses. Run from this directory; needs Pillow.
"""
from PIL import Image, ImageDraw, ImageFont

ACCENT = (0xC9, 0x64, 0x42)
FONT = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf"
OUT = "Assets.xcassets/AppIcon.appiconset"


def glyph(size, background_alpha=255):
    img = Image.new("RGBA", (size, size), ACCENT + (background_alpha,))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * 0.72))
    # Centre on the glyph's ink box, not its em box: a "b" has an ascender
    # and no descender, so em-centring sits it visibly low.
    l, t, r, b = d.textbbox((0, 0), "b", font=font)
    x = (size - (r - l)) / 2 - l
    y = (size - (b - t)) / 2 - t
    d.text((x, y), "b", font=font, fill=(255, 255, 255, 255))
    return img


def rounded(img, radius_frac=0.2237):
    """Apple's macOS icon shape, near enough: a rounded square with 10% margin."""
    size = img.size[0]
    inset = int(size * 0.10)
    inner = size - 2 * inset
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, inner - 1, inner - 1),
                                           radius=int(inner * radius_frac), fill=255)
    tile = img.resize((inner, inner), Image.LANCZOS)
    canvas.paste(tile, (inset, inset), mask)
    return canvas


base = glyph(1024)
base.save(f"{OUT}/icon-1024.png")
mac = rounded(base)
for px in (16, 32, 64, 128, 256, 512, 1024):
    mac.resize((px, px), Image.LANCZOS).save(f"{OUT}/mac-{px}.png")
print("wrote icon-1024.png and mac-{16..1024}.png")
