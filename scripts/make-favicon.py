#!/usr/bin/env python3
"""Draws a placeholder favicon: gold "LB" on dark espresso. No third-party libraries.

    python3 scripts/make-favicon.py tenants/labella/favicon.ico [--bg #3D2E22] [--fg #B6935A]

Replace the output with the real crest later (a 32x32 or 48x48 .ico/.png is fine).
"""
import math
import struct
import sys
import zlib


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def in_rect(x, y, x0, y0, x1, y1):
    return x0 <= x <= x1 and y0 <= y <= y1


def half_disc(x, y, cx, cy, r):
    return x >= cx and (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def letter_L(x, y):
    return in_rect(x, y, 12, 18, 17.5, 46) or in_rect(x, y, 12, 41, 30, 46)


def letter_B(x, y):
    stem = in_rect(x, y, 34, 18, 38.5, 46)
    top = in_rect(x, y, 34, 18, 43, 32.5) or half_disc(x, y, 43, 25.25, 7.25)
    bottom = in_rect(x, y, 34, 28, 41, 46) or half_disc(x, y, 41, 37, 9)
    hole_top = in_rect(x, y, 38.5, 22.5, 43, 28) or half_disc(x, y, 43, 25.25, 2.75)
    hole_bot = in_rect(x, y, 38.5, 32.5, 41, 41.5) or half_disc(x, y, 41, 37, 4.5)
    return (stem or top or bottom) and not (hole_top or hole_bot)


def rounded_square(x, y, r=11):
    if not in_rect(x, y, 0, 0, 64, 64):
        return False
    cx = min(max(x, r), 64 - r)
    cy = min(max(y, r), 64 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size, bg, fg, ss=6):
    """Supersampled RGBA pixels (list of rows of (r,g,b,a))."""
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            a = c_bg = c_fg = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * 64 / size
                    y = (py + (sy + 0.5) / ss) * 64 / size
                    if rounded_square(x, y):
                        a += 1
                        if letter_L(x, y) or letter_B(x, y):
                            c_fg += 1
                        else:
                            c_bg += 1
            n = ss * ss
            if a == 0:
                row.append((0, 0, 0, 0))
                continue
            col = tuple(round((bg[i] * c_bg + fg[i] * c_fg) / a) for i in range(3))
            row.append(col + (round(255 * a / n),))
        rows.append(row)
    return rows


def png(rows):
    h, w = len(rows), len(rows[0])
    raw = b''.join(b'\x00' + b''.join(bytes(p) for p in row) for row in rows)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def ico(images):
    head = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b'', b''
    for size, data in images:
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return head + entries + blobs


if __name__ == '__main__':
    args = sys.argv[1:]
    out = args[0] if args else 'favicon.ico'
    opt = {args[i]: args[i + 1] for i in range(1, len(args) - 1, 2)}
    bg, fg = hex_rgb(opt.get('--bg', '#3D2E22')), hex_rgb(opt.get('--fg', '#B6935A'))
    sizes = [16, 32, 48]
    images = [(s, png(render(s, bg, fg))) for s in sizes]
    open(out, 'wb').write(ico(images))
    open(out.replace('.ico', '-preview.png'), 'wb').write(png(render(256, bg, fg, ss=3)))
    print('wrote', out, [len(d) for _, d in images], 'bytes per size')
