#!/usr/bin/env python3
"""生成地图预览图、显示用压缩图、大地图 2 倍放大版与应用图标。

原始图片（尼沙皇吊图/）不会被修改，产物全部写到 assets/ 下。
显示用图（assets/maps/）是给软件实际加载的压缩副本，打包只带这一份。
应用图标由 assets/icon-source.jpg 裁切生成（换图标只需替换这张原图）。
用法：python tools/make-previews.py
"""

from __future__ import annotations

import argparse
import json
import shutil
import numpy as np
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, ImageSequence

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "尼沙皇吊图"
OUT_DIR = ROOT / "assets" / "previews"
MAPS_OUT_DIR = ROOT / "assets" / "maps"
CONFIG_FILE = ROOT / "config" / "regions.json"
ICON_SOURCE = ROOT / "assets" / "icon-source.jpg"
SPLASH_FILE = ROOT / "assets" / "portable-splash.bmp"
# 图标取景（源图像素坐标，正方形）：框住画面里两个人物
ICON_CROP = (138, 24, 1058, 944)
MAX_EDGE = 2400
QUALITY = 82
# 显示用图的编码质量（按源文件类型区分）
DISPLAY_QUALITY = {".png": 92, ".jpg": 86, ".jpeg": 86, ".webp": 92, ".gif": 88}
FALLBACK_QUALITIES = [82, 76]
SMALLER_THAN_SOURCE = 0.92
DANCE_QUALITY = 80
# 免安装版解压阶段启动图：人物正方形的边长（像素）
SPLASH_ART_EDGE = 336
# 主界面图片的美化预设：gamma/对比度/饱和度/暗部提亮 + 锐化 + 暗角
POLISH_PRESETS = {
    "off": None,
    "soft": {"gamma": 0.94, "contrast": 1.06, "saturate": 1.10, "lift": 0.03, "unsharp": (2.0, 55, 4), "vignette": 0.12},
    "medium": {"gamma": 0.90, "contrast": 1.10, "saturate": 1.15, "lift": 0.05, "unsharp": (1.8, 70, 5), "vignette": 0.20},
    "strong": {"gamma": 0.85, "contrast": 1.16, "saturate": 1.25, "lift": 0.08, "unsharp": (2.2, 105, 4), "vignette": 0.30},
}


def open_image(name: str) -> Image.Image:
    path = SRC_DIR / name
    if not path.exists():
        raise SystemExit(f"缺少图片：{path}")
    with Image.open(path) as raw:
        img = ImageOps.exif_transpose(raw)
        return img.convert("RGB")


def save_webp(img: Image.Image, out_name: str, max_edge: int = MAX_EDGE) -> tuple[int, int, int]:
    out = OUT_DIR / Path(out_name).name
    out.parent.mkdir(parents=True, exist_ok=True)
    w, h = img.size
    scale = min(1.0, max_edge / max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    img.save(out, "WEBP", quality=QUALITY, method=6)
    return img.size[0], img.size[1], out.stat().st_size


def polish_image(img: Image.Image, preset: str) -> Image.Image:
    """主界面美化：提亮暗部、补一点对比与饱和、温和锐化，最后压一层轻暗角。"""
    params = POLISH_PRESETS.get(preset or "medium")
    if not params:
        return img
    data = np.asarray(img, dtype=np.float32) / 255.0
    data = np.power(data, params["gamma"])
    data = data + params["lift"] * (1.0 - data)
    data = np.clip((data - 0.5) * params["contrast"] + 0.5, 0.0, 1.0)
    gray = (data * np.array([0.299, 0.587, 0.114], dtype=np.float32)).sum(axis=2, keepdims=True)
    data = np.clip(gray + (data - gray) * params["saturate"], 0.0, 1.0)
    out = Image.fromarray((data * 255).astype(np.uint8))

    radius, percent, threshold = params["unsharp"]
    out = out.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold))

    strength = params["vignette"]
    if strength:
        width, height = out.size
        ys, xs = np.mgrid[0:height, 0:width]
        cx, cy = width / 2, height / 2
        norm = np.sqrt(((xs - cx) / cx) ** 2 + ((ys - cy) / cy) ** 2) / np.sqrt(2)
        mask = np.clip(1 - strength * (norm**2.4), 0.0, 1.0)
        arr = np.asarray(out, dtype=np.float32)
        out = Image.fromarray((arr * mask[:, :, None]).astype(np.uint8))
    return out


def encode_display(region: dict, source_name: str) -> tuple[str, int]:
    """转成 WebP；如果转完反而更大，就直接复制原文件。返回 (相对 assets 的路径, 体积)。"""
    source_path = SRC_DIR / source_name
    source_size = source_path.stat().st_size
    img = open_image(source_name)
    quality = DISPLAY_QUALITY.get(source_path.suffix.lower(), 88)
    target = MAPS_OUT_DIR / f"{region['id']}.webp"
    for attempt in [quality, *FALLBACK_QUALITIES]:
        img.save(target, "WEBP", quality=attempt, method=6)
        size = target.stat().st_size
        if size <= source_size * SMALLER_THAN_SOURCE:
            return f"maps/{target.name}", size
    target.unlink(missing_ok=True)
    copy_name = f"{region['id']}{source_path.suffix.lower()}"
    shutil.copyfile(source_path, MAPS_OUT_DIR / copy_name)
    return f"maps/{copy_name}", source_size


def make_display_maps(config: dict) -> list[tuple[str, str, float, float]]:
    """给每张地图生成显示副本（等分辨率），并把路径写回配置。"""
    rows: list[tuple[str, str, float, float]] = []
    MAPS_OUT_DIR.mkdir(parents=True, exist_ok=True)
    for region in config["regions"]:
        source = region["image"]
        with Image.open(SRC_DIR / source) as raw:
            size_text = f"{raw.width}x{raw.height}"
        display, size = encode_display(region, source)
        region["display"] = display
        source_size = (SRC_DIR / source).stat().st_size
        rows.append((region["name"], size_text, source_size / 1048576, size / 1048576))
    return rows


def make_display_dance(config: dict) -> tuple[str, float, float] | None:
    """跳舞动图：GIF 转成动画 WebP，其它格式原样复制。"""
    name = (config.get("extras") or {}).get("danceGif")
    if not name:
        return None
    source = SRC_DIR / name
    if not source.exists():
        print(f"没有找到跳舞动图 {source}，跳过")
        return None
    MAPS_OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = MAPS_OUT_DIR / "dance.webp"
    frame_count = 1
    source_size = source.stat().st_size
    if source.suffix.lower() == ".gif":
        with Image.open(source) as gif:
            frames = [frame.convert("RGB") for frame in ImageSequence.Iterator(gif)]
            durations = [frame.info.get("duration", gif.info.get("duration", 80)) for frame in ImageSequence.Iterator(gif)]
        frame_count = len(frames)
        frames[0].save(
            out,
            "WEBP",
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=0,
            quality=DANCE_QUALITY,
            method=6,
        )
    else:
        shutil.copyfile(source, out)
    size = out.stat().st_size
    if size > source_size * SMALLER_THAN_SOURCE:
        out.unlink(missing_ok=True)
        copy_name = f"dance{source.suffix.lower()}"
        shutil.copyfile(source, MAPS_OUT_DIR / copy_name)
        config["extras"]["danceDisplay"] = f"maps/{copy_name}"
        size = source_size
    else:
        config["extras"]["danceDisplay"] = "maps/dance.webp"
    return f"{frame_count} 帧", size / 1048576, source_size / 1048576


def make_icon() -> None:
    if not ICON_SOURCE.exists():
        print(f"没有找到图标原图 {ICON_SOURCE}，跳过图标生成")
        return
    with Image.open(ICON_SOURCE) as raw:
        img = ImageOps.exif_transpose(raw).convert("RGB")
    x0, y0, x1, y1 = ICON_CROP
    if x1 > img.width or y1 > img.height or x1 - x0 != y1 - y0:
        side = min(img.size)
        x0 = (img.width - side) // 2
        y0 = (img.height - side) // 2
        x1, y1 = x0 + side, y0 + side
    square = img.crop((x0, y0, x1, y1)).resize((512, 512), Image.LANCZOS)
    square.save(ROOT / "assets" / "icon.png", "PNG")
    square.save(
        ROOT / "assets" / "icon.ico",
        "ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def load_font(size: int):
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_portable_splash(config: dict) -> None:
    """免安装版解压阶段显示的启动图（electron-builder 要求 BMP）。

    素材在 config/regions.json 的 extras.splashImage（相对 assets/），默认和图标同一张原图；
    想换解压画面就换那张图，或者把这一项指向 assets/ 下的别的文件。
    """
    extras = config.get("extras") or {}
    source = ROOT / "assets" / (extras.get("splashImage") or ICON_SOURCE.name)
    if not source.exists():
        print(f"没有找到启动图素材 {source}，跳过")
        return

    with Image.open(source) as raw:
        art = ImageOps.exif_transpose(raw).convert("RGB")
    x0, y0, x1, y1 = ICON_CROP
    if x1 <= art.width and y1 <= art.height:
        art = art.crop((x0, y0, x1, y1))  # 和图标同一套取景：正好框住两个人物
    else:
        side = min(art.size)
        left, top = (art.width - side) // 2, (art.height - side) // 2
        art = art.crop((left, top, left + side, top + side))
    edge = min(art.width, art.height, SPLASH_ART_EDGE)
    art = art.resize((edge, edge), Image.LANCZOS)

    pad, title_h, sub_h = 16, 32, 26
    width = edge + pad * 2
    height = pad + edge + 10 + title_h + sub_h + pad
    canvas = Image.blend(
        Image.new("RGB", (width, height), (9, 11, 14)),
        art.resize((24, 24), Image.LANCZOS).resize((width, height), Image.BICUBIC),
        0.32,
    )
    canvas.paste(art, ((width - edge) // 2, pad))

    draw = ImageDraw.Draw(canvas)
    title_font = load_font(17)
    small_font = load_font(12)
    title = "尼沙皇版图浏览小工具"
    subtitle = "正在解压启动，请稍候…"
    title_width = draw.textlength(title, font=title_font)
    draw.text(((width - title_width) / 2, pad + edge + 10), title, font=title_font, fill=(241, 236, 227))
    sub_width = draw.textlength(subtitle, font=small_font)
    draw.text(((width - sub_width) / 2, pad + edge + 10 + title_h), subtitle, font=small_font, fill=(178, 186, 196))
    canvas.save(SPLASH_FILE, "BMP")


def main() -> None:
    parser = argparse.ArgumentParser(description="生成预览图、显示副本、图标与解压启动图")
    parser.add_argument("--only", choices=["splash"], help="只重做解压阶段那张启动图（BMP）")
    args = parser.parse_args()

    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if args.only == "splash":
        make_portable_splash(config)
        print(f"免安装版解压启动图：{SPLASH_FILE.relative_to(ROOT)}")
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    rows: list[tuple[str, str, str, str]] = []
    overview = open_image(config["overview"]["image"])
    crop = config["overview"].get("crop")
    if crop:
        x, y, w, h = crop
        overview = overview.crop((x, y, x + w, y + h))
    polish = config["overview"].get("polish", "medium")
    overview = polish_image(overview, polish)
    native = overview.size

    save_webp(overview, config["overview"]["preview"], max_edge=max(native))
    upscaled = overview.resize((native[0] * 2, native[1] * 2), Image.LANCZOS)
    save_webp(upscaled, config["overview"]["display"], max_edge=max(upscaled.size))
    rows.append((config["overview"]["name"], config["overview"]["image"], f"{native[0]}x{native[1]}", f"1x + 2x（美化 {polish}）"))

    for region in config["regions"]:
        img = open_image(region["image"])
        pw, ph, size = save_webp(img, region["preview"])
        rows.append(
            (
                region["name"],
                region["image"],
                f"{img.size[0]}x{img.size[1]}",
                f"{pw}x{ph} / {size / 1024:.0f} KB",
            )
        )

    make_icon()
    make_portable_splash(config)

    print(f"预览图输出目录：{OUT_DIR}")
    for name, src, origin, preview in rows:
        print(f"  {name:<6} {src:<14} 原图 {origin:<10} 预览 {preview}")

    display_rows = make_display_maps(config)
    dance = make_display_dance(config)
    total_source = sum(
        (SRC_DIR / region["image"]).stat().st_size for region in config["regions"]
    ) / 1048576
    total_display = sum(row[3] for row in display_rows)
    config["extras"] = config.get("extras") or {}
    CONFIG_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n显示用图输出目录：{MAPS_OUT_DIR}")
    for name, size, source_size, display_size in display_rows:
        print(f"  {name:<6} {size:<10} {source_size:5.2f} MB → {display_size:5.2f} MB")
    print(f"  合计 {total_source:.1f} MB → {total_display:.1f} MB")
    if dance:
        print(f"  跳舞动图 {dance[0]}：{dance[2]:.1f} MB → {dance[1]:.2f} MB")
    print(f"  已把显示路径写回 {CONFIG_FILE.relative_to(ROOT)}（display / extras.danceDisplay）")
    print(f"图标：assets/icon.png, assets/icon.ico（取自 {ICON_SOURCE.name}）")
    print(f"免安装版解压启动图：{SPLASH_FILE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
