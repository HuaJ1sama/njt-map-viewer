#!/usr/bin/env python3
"""从 eftarkov.com 的物品价格接口生成 scav 宝箱的物资表。

数据来源：https://www.eftarkov.com/ 的公开接口 api.eftarkov.com/boss.php?id=10（PVP 模式），
物品名与价格均为该站数据（跳蚤市场最近最低价，若无则取最高商人收购价，再退回基础价）。

用法：
    python tools/make-scav-loot.py                     # 联网抓取后生成
    python tools/make-scav-loot.py --api-json 缓存.json # 用已下载的接口数据生成
    python tools/make-scav-loot.py --list-categories    # 只打印分类统计
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_FILE = ROOT / "config" / "scav-loot.json"
API_URL = "https://api.eftarkov.com/boss.php?id=10"

# 参考的分类 -> 界面上显示的分类名
CATEGORY_MAP = {
    "药品": "医疗",
    "医疗用品": "医疗",
    "医疗物资": "医疗",
    "医疗物品": "医疗",
    "注射器": "医疗",
    "交换用物品": "物资",
    "贵重物品": "贵重",
    "情报物品": "情报",
    "笔记": "情报",
    "机械钥匙": "钥匙",
    "电子钥匙": "钥匙",
    "钥匙": "钥匙",
    "弹药包": "弹药",
    "饮食": "食物",
    "食物": "食物",
    "电子产品": "电子",
    "基础部件": "零件",
    "背包": "装备",
    "战术胸挂": "装备",
    "防弹衣": "装备",
    "头部装备": "装备",
    "面部装备": "装备",
    "眼部装备": "装备",
    "耳机": "装备",
    "突击步枪": "武器",
    "突击卡宾枪": "武器",
    "手枪": "武器",
    "霰弹枪": "武器",
    "冲锋枪": "武器",
    "栓动式步枪": "武器",
    "精确射手步枪": "武器",
}

# 每个分类最多挑几件（按价格分层抽样，保证贵的便宜的都有）
PER_CATEGORY = 10
MIN_PRICE = 2000
MAX_PRICE = 2500000

# 权重与价格成反比：便宜货常见、天价货罕见。WEIGHT_SCALE 越大越容易出货。
WEIGHT_SCALE = 260000
WEIGHT_POWER = 1.1
WEIGHT_MIN = 0.01
WEIGHT_MAX = 5000.0
# 数量区间：便宜的东西可以多带几个
QTY_BUCKETS = [
    (8000, [1, 4]),
    (25000, [1, 3]),
    (60000, [1, 2]),
    (float("inf"), [1, 1]),
]


def fetch_api(cache_file: Path | None) -> dict:
    if cache_file:
        return json.loads(cache_file.read_text(encoding="utf-8"))
    request = urllib.request.Request(
        API_URL,
        headers={
            "Accept": "application/json",
            "Referer": "https://www.eftarkov.com/news/web_210.html",
            "Origin": "https://www.eftarkov.com",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
            ),
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def item_price(item: dict) -> int:
    # 与 wiki「物资物价天梯排行」口径一致：取跳蚤市场最近最低价与最高商人收购价的较大者，
    # 两者都没有时才退回基础价。
    flea = item.get("lastLowPrice") or 0
    trader = 0
    for entry in item.get("traderPrices") or []:
        trader = max(trader, entry.get("priceRUB") or 0)
    price = max(flea, trader)
    if price <= 0:
        price = item.get("basePrice") or 0
    return int(price)


def display_category(item: dict) -> str | None:
    for entry in item.get("handbookCategories") or []:
        name = entry.get("name") if isinstance(entry, dict) else entry
        if name in CATEGORY_MAP:
            return CATEGORY_MAP[name]
    return None


def weight_of(price: int, scale: float = WEIGHT_SCALE, power: float = WEIGHT_POWER) -> float:
    raw = (scale / max(price, 1)) ** power
    return round(min(WEIGHT_MAX, max(WEIGHT_MIN, raw)), 4)


def qty_of(price: int) -> list[int]:
    for limit, qty in QTY_BUCKETS:
        if price < limit:
            return qty
    return QTY_BUCKETS[-1][1]


def pick_items(items: list[dict], scale: float = WEIGHT_SCALE, power: float = WEIGHT_POWER) -> list[dict]:
    """每个分类按价格做分层抽样，避免整张表全是垃圾或者全是天价货。"""
    grouped: dict[str, list[dict]] = {}
    seen_names: set[str] = set()
    for item in items:
        name = (item.get("name") or "").strip()
        price = item_price(item)
        category = display_category(item)
        if not name or not category or name in seen_names:
            continue
        if price < MIN_PRICE or price > MAX_PRICE:
            continue
        seen_names.add(name)
        grouped.setdefault(category, []).append({"raw": item, "name": name, "price": price})

    picked: list[dict] = []
    for category, entries in grouped.items():
        entries.sort(key=lambda entry: entry["price"])
        total = len(entries)
        if total <= PER_CATEGORY:
            chosen = entries
        else:
            # 按价格分位均匀取点，贵贱都有
            chosen = [
                entries[min(total - 1, round(index * (total - 1) / (PER_CATEGORY - 1)))]
                for index in range(PER_CATEGORY)
            ]
        for entry in chosen:
            raw = entry["raw"]
            picked.append(
                {
                    "name": entry["name"],
                    "category": category,
                    "value": entry["price"],
                    "weight": weight_of(entry["price"], scale, power),
                    "qty": qty_of(entry["price"]),
                    "slots": [raw.get("width") or 1, raw.get("height") or 1],
                }
            )
    picked.sort(key=lambda entry: (entry["category"], entry["value"]))
    return picked


def simulate(items: list[dict], cost: int, runs: int = 200000) -> dict:
    total_weight = sum(item["weight"] for item in items)
    totals = []
    for _ in range(runs):
        count = random.randint(3, 6)
        if random.random() < 0.35:
            count += 1
        if random.random() < 0.12:
            count += 2
        haul = 0
        for _ in range(count):
            ticket = random.random() * total_weight
            for item in items:
                ticket -= item["weight"]
                if ticket <= 0:
                    haul += item["value"] * random.randint(item["qty"][0], item["qty"][1])
                    break
        totals.append(haul)
    totals.sort()
    mean = sum(totals) / runs
    wins = sum(1 for value in totals if value > cost)
    return {
        "mean": round(mean),
        "median": totals[runs // 2],
        "p10": totals[int(runs * 0.1)],
        "p90": totals[int(runs * 0.9)],
        "profit_rate": round(wins / runs, 3),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-json", type=Path, default=None)
    parser.add_argument("--list-categories", action="store_true")
    parser.add_argument("--out", type=Path, default=OUT_FILE)
    parser.add_argument("--weight-scale", type=float, default=WEIGHT_SCALE)
    parser.add_argument("--weight-power", type=float, default=WEIGHT_POWER)
    parser.add_argument("--dry-run", action="store_true", help="只模拟，不写文件")
    args = parser.parse_args()

    payload = fetch_api(args.api_json)
    items = payload["raw_api_data"]["data"]["items"]

    if args.list_categories:
        counts: dict[str, int] = {}
        for item in items:
            for entry in item.get("handbookCategories") or []:
                name = entry.get("name") if isinstance(entry, dict) else entry
                counts[name] = counts.get(name, 0) + 1
        for name, count in sorted(counts.items(), key=lambda pair: -pair[1]):
            print(f"{count:5d}  {name}")
        return

    picked = pick_items(items, args.weight_scale, args.weight_power)
    cost = 95000
    stats = simulate(picked, cost)
    result = {
        "version": 2,
        "source": "https://www.eftarkov.com/",
        "sourceApi": API_URL,
        "fetchedAt": dt.date.today().isoformat(),
        "cost": cost,
        "minRolls": 3,
        "maxRolls": 6,
        "extraRollChance": 0.35,
        "bigRollChance": 0.12,
        "items": [
            {
                "name": item["name"],
                "category": item["category"],
                "value": item["value"],
                "weight": item["weight"],
                "qty": item["qty"],
            }
            for item in picked
        ],
    }
    if not args.dry_run:
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    by_category: dict[str, int] = {}
    for item in picked:
        by_category[item["category"]] = by_category.get(item["category"], 0) + 1
    priced = sorted(picked, key=lambda entry: -entry["value"])
    print(f"已写入 {args.out}")
    print(f"物品 {len(picked)} 件：" + "、".join(f"{name} {count}" for name, count in sorted(by_category.items())))
    print("  最贵：" + " / ".join(f"{item['name']} ₽{item['value']:,}" for item in priced[:5]))
    print("  最便宜：" + " / ".join(f"{item['name']} ₽{item['value']:,}" for item in priced[-5:]))
    print(
        "模拟 {runs} 次：均值 ₽{mean:,} 中位 ₽{median:,} 10% 分位 ₽{p10:,} 90% 分位 ₽{p90:,} 回本率 {profit_rate:.1%}".format(
            runs=200000, **stats
        )
    )


if __name__ == "__main__":
    main()
