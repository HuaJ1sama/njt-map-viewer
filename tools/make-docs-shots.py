#!/usr/bin/env python3
"""把 tools/screenshots/ 里的界面截图压成 README 用的图（docs/screenshots/）。

用法：python tools/make-docs-shots.py   （先跑 npm run shots 生成原图）
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "tools" / "screenshots"
OUT_DIR = ROOT / "docs" / "screenshots"
MAX_EDGE = 1600
QUALITY = 84

# (tools/screenshots 里的原名, docs/screenshots 里的新名, 说明)
PICKS = [
    ("1-overview", "01-overview", "诺文斯克大地图"),
    ("3-map-annotated", "02-annotated", "地区地图与标注"),
    ("5-map-tasks", "03-tasks", "跨地图任务框"),
    ("8-scav-box", "04-scav", "scav 宝箱彩蛋"),
    ("11-loading", "05-loading", "启动加载页"),
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for source_name, target_name, caption in PICKS:
        source = SRC_DIR / f"{source_name}.png"
        if not source.exists():
            print(f"缺少 {source.name}，先跑 npm run shots")
            continue
        with Image.open(source) as raw:
            image = raw.convert("RGB")
        scale = min(1.0, MAX_EDGE / max(image.size))
        if scale < 1.0:
            image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
        target = OUT_DIR / f"{target_name}.jpg"
        image.save(target, "JPEG", quality=QUALITY, optimize=True)
        print(f"{caption}：{target.relative_to(ROOT).as_posix()}（{target.stat().st_size / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
