"""Generate original ClaudaCoda raster artwork from first-party vector geometry.

Requires Pillow. Outputs icons and an illustrative Marketplace thumbnail, not a
product screenshot. No third-party images, logos, or generative models are used.
"""
from __future__ import annotations

import math
import shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "assets"
ICONS = ROOT / "src-tauri" / "icons"


def curve(start, control1, control2, finish):
    points = []
    for step in range(1, 25):
        t = step / 24
        points.append(tuple((1 - t) ** 3 * start[i] + 3 * (1 - t) ** 2 * t * control1[i]
                            + 3 * (1 - t) * t * t * control2[i] + t ** 3 * finish[i] for i in range(2)))
    return points


def icon(size):
    scale = max(4, math.ceil(size / 128))
    image = Image.new("RGBA", (128 * scale, 128 * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((2 * scale, 2 * scale, 126 * scale, 126 * scale), radius=33 * scale, fill="#171d36")
    left = [(72, 32), (49, 32)]
    left += curve((49, 32), (34, 32), (22, 44), (22, 59))
    left += [(22, 73)] + curve((22, 73), (22, 85), (31, 96), (43, 99))
    left += [(43, 83)] + curve((43, 83), (37, 81), (33, 76), (33, 70))
    left += [(33, 60)] + curve((33, 60), (33, 51), (40, 44), (49, 44)) + [(72, 44)]
    right = [(128 - x, 128 - y) for x, y in left]

    def stroke(points, color, width):
        scaled = [(round(x * scale), round(y * scale)) for x, y in points]
        draw.line(scaled, fill=color, width=width * scale, joint="curve")
        radius = width * scale / 2
        for x, y in (scaled[0], scaled[-1]):
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)

    stroke(left, "#80adff", 10)
    stroke(right, "#ad96ff", 10)
    stroke([(50, 58), (78, 58)], "#8b98fb", 6)
    stroke([(50, 70), (70, 70)], "#9890fc", 6)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def font(size, bold=False):
    candidate = Path("C:/Windows/Fonts") / ("seguisb.ttf" if bold else "segoeui.ttf")
    if not candidate.exists():
        raise RuntimeError("Artwork needs the standard Windows Segoe UI font.")
    return ImageFont.truetype(str(candidate), size)


def thumbnail():
    image = Image.new("RGB", (1600, 900), "#101322")
    draw = ImageDraw.Draw(image)
    for y in range(900):
        t = y / 900
        draw.line((0, y, 1600, y), fill=(int(16 + 4 * t), int(19 + 5 * t), int(34 + 12 * t)))
    draw.rounded_rectangle((71, 65, 1529, 835), radius=35, outline="#2a3046", width=2)
    mark = icon(106)
    image.paste(mark, (126, 127), mark)
    draw.text((253, 141), "ClaudaCoda", fill="#edf0fd", font=font(47, True))
    draw.text((254, 205), "EXPLICIT SCOPE. EVERY HANDOFF RECORDED.", fill="#9aafff", font=font(14, True))
    draw.text((128, 323), "Two agents.", fill="#edf0fd", font=font(75, True))
    draw.text((128, 414), "Your direction.", fill="#9aafff", font=font(75, True))
    draw.text((132, 535), "A local coordination workbench for", fill="#929bb7", font=font(24))
    draw.text((132, 573), "Codex and Claude Code.", fill="#929bb7", font=font(24))
    # Illustrative coordination diagram, deliberately not a fake app screenshot.
    for x, y, title, subtitle, color in [(928, 303, "Codex", "QUESTION  /  REVIEW", "#80adff"), (1038, 512, "Claude Code", "SCOPED DELEGATION", "#ad96ff")]:
        draw.rounded_rectangle((x, y, x + 330, y + 140), radius=21, fill="#181d30", outline="#37425f", width=2)
        draw.rounded_rectangle((x + 22, y + 24, x + 72, y + 74), radius=13, fill="#222a44")
        draw.text((x + 36, y + 26), "C", fill=color, font=font(29, True))
        draw.text((x + 89, y + 30), title, fill="#edf0fd", font=font(26, True))
        draw.text((x + 24, y + 101), subtitle, fill=color, font=font(13, True))
    draw.line([(969, 445), (969, 476), (1092, 476), (1092, 501)], fill="#6377b7", width=3)
    draw.polygon([(1086, 494), (1092, 505), (1098, 494)], fill="#9aafff")
    draw.line([(1332, 510), (1332, 476), (1202, 476), (1202, 455)], fill="#8f7ac2", width=3)
    draw.polygon([(1196, 459), (1202, 448), (1208, 459)], fill="#ad96ff")
    draw.line((129, 720, 1467, 720), fill="#2a3046", width=2)
    draw.text((132, 754), "OWNER GRANTS     /     DEDICATED SESSIONS     /     DURABLE RECEIPTS", fill="#929bb7", font=font(16, True))
    draw.text((1334, 754), "DeloresAI", fill="#929bb7", font=font(16))
    image.save(ART / "marketplace-thumbnail.png", optimize=True)


def main():
    ART.mkdir(exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)
    master = icon(1024)
    master.save(ART / "marketplace-icon.png", optimize=True)
    for size, name in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
        icon(size).save(ICONS / name, optimize=True)
    master.save(ICONS / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    shutil.copyfile(ROOT / "ui" / "brand.svg", ART / "brand.svg")
    thumbnail()
    print("Generated original 1024px icon, 1600x900 illustrative thumbnail, and Windows ICO (16–256px).")


if __name__ == "__main__":
    main()
