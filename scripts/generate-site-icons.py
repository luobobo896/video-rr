"""Generate the complete browser/PWA icon set from the approved Yingchao artwork."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]


def save_png(image: Image.Image, path: Path, size: int, *, sharpen: bool = False) -> None:
    rendered = image.resize((size, size), Image.Resampling.LANCZOS)
    if sharpen:
        rendered = rendered.filter(ImageFilter.UnsharpMask(radius=0.6, percent=120, threshold=2))
        rendered = ImageEnhance.Contrast(rendered).enhance(1.06)
    rendered.save(path, "PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--icon",
        type=Path,
        default=Path.home() / "Downloads/yingchao-assets/影巢影视平台/02-icon.png",
    )
    parser.add_argument(
        "--logo",
        type=Path,
        default=Path.home() / "Downloads/yingchao-assets/影巢影视平台/01-logo.png",
    )
    args = parser.parse_args()

    icon = Image.open(args.icon).convert("RGBA")
    logo = Image.open(args.logo).convert("RGB")
    if icon.width != icon.height:
        side = min(icon.width, icon.height)
        left = (icon.width - side) // 2
        top = (icon.height - side) // 2
        icon = icon.crop((left, top, left + side, top + side))

    # Small browser icons need a tighter crop or the film reel disappears at 16px.
    edge = round(icon.width * 0.09)
    tight = icon.crop((edge, edge, icon.width - edge, icon.height - edge))

    public_dir = ROOT / "public"
    admin_dir = ROOT / "admin"
    icon_dir = public_dir / "icons"
    brand_dir = public_dir / "brand"
    admin_icon_dir = admin_dir / "icons"
    for folder in (icon_dir, brand_dir, admin_icon_dir):
        folder.mkdir(parents=True, exist_ok=True)

    master = icon.resize((1024, 1024), Image.Resampling.LANCZOS)
    master.save(brand_dir / "icon-1024.png", "PNG", optimize=True)
    logo.save(brand_dir / "logo.png", "PNG", optimize=True)

    browser_sizes = (16, 24, 32, 48, 64, 96, 128, 256)
    platform_sizes = (36, 48, 57, 60, 64, 70, 72, 76, 96, 114, 120, 144, 150, 152, 167, 180, 192, 256, 310, 384, 512)
    for size in browser_sizes:
        save_png(tight, icon_dir / f"favicon-{size}x{size}.png", size, sharpen=size <= 48)
    for size in platform_sizes:
        save_png(icon, icon_dir / f"icon-{size}x{size}.png", size, sharpen=size <= 72)
    save_png(icon, icon_dir / "icon-1024.png", 1024)

    # PWA maskable icon: artwork stays inside the central safe area on a full-bleed tile.
    save_png(icon, icon_dir / "icon-maskable-512.png", 512)

    # Wide Windows tile.
    wide = Image.new("RGBA", (310, 150), (7, 5, 12, 255))
    mark = icon.resize((140, 140), Image.Resampling.LANCZOS)
    wide.alpha_composite(mark, (10, 5))
    wide.save(icon_dir / "mstile-310x150.png", "PNG", optimize=True)

    tight.resize((48, 48), Image.Resampling.LANCZOS).save(
        public_dir / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48)],
    )
    shutil.copy2(public_dir / "favicon.ico", admin_dir / "favicon.ico")
    (public_dir / "favicon-32x32.png").write_bytes((icon_dir / "favicon-32x32.png").read_bytes())
    shutil.copy2(public_dir / "favicon-32x32.png", admin_dir / "favicon-32x32.png")
    shutil.copy2(icon_dir / "favicon-16x16.png", public_dir / "favicon-16x16.png")
    shutil.copy2(icon_dir / "favicon-16x16.png", admin_dir / "favicon-16x16.png")
    shutil.copy2(icon_dir / "icon-180x180.png", public_dir / "apple-touch-icon.png")
    shutil.copy2(icon_dir / "icon-180x180.png", admin_dir / "apple-touch-icon.png")

    for name in ("icon-192x192.png", "icon-384x384.png", "icon-512x512.png", "icon-maskable-512.png", "icon-1024.png", "mstile-310x150.png"):
        shutil.copy2(icon_dir / name, admin_icon_dir / name)
    for size in (48, 57, 60, 64, 72, 76, 96, 114, 120, 144, 150, 152, 167, 180, 256, 310):
        name = f"icon-{size}x{size}.png"
        shutil.copy2(icon_dir / name, admin_icon_dir / name)

    cover = logo.resize((1200, 675), Image.Resampling.LANCZOS)
    cover = cover.crop((0, 22, 1200, 652))
    cover.save(brand_dir / "og-cover.jpg", "JPEG", quality=88, optimize=True, progressive=True)

    print(f"Generated icons in {icon_dir}")
    print(f"Generated admin icons in {admin_icon_dir}")


if __name__ == "__main__":
    main()
