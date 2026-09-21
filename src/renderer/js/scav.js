(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NJTScav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  function pickWeighted(items, totalWeight) {
    let ticket = Math.random() * totalWeight;
    for (const item of items) {
      ticket -= item.weight;
      if (ticket <= 0) return item;
    }
    return items[items.length - 1];
  }

  /** 一次开箱：随机件数 + 按权重抽物品，同名物品合并。 */
  function roll(loot) {
    const items = (loot && loot.items) || [];
    if (!items.length) return { picks: [], total: 0, cost: loot?.cost || 0, profit: 0, rolls: 0 };
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    let count = randInt(loot.minRolls, loot.maxRolls);
    if (Math.random() < (loot.extraRollChance || 0)) count += 1;
    if (Math.random() < (loot.bigRollChance || 0)) count += 2;

    const picks = [];
    for (let i = 0; i < count; i += 1) {
      const item = pickWeighted(items, totalWeight);
      const qty = randInt(item.qty[0], item.qty[1]);
      const existing = picks.find((pick) => pick.name === item.name);
      if (existing) existing.qty += qty;
      else picks.push({ name: item.name, category: item.category, value: item.value, qty });
    }
    let total = 0;
    for (const pick of picks) {
      pick.total = pick.value * pick.qty;
      total += pick.total;
    }
    picks.sort((a, b) => b.total - a.total);
    const cost = loot.cost || 0;
    return { picks, total, cost, profit: total - cost, rolls: count };
  }

  /** 稀有度用于界面配色：高价值金、中等蓝、其余灰。 */
  function rarityOf(pick) {
    if (pick.total >= 200000 || pick.value >= 200000) return 'rare';
    if (pick.total >= 50000 || pick.value >= 50000) return 'good';
    return 'common';
  }

  function formatRubles(amount) {
    const sign = amount < 0 ? '-' : '';
    return `${sign}₽${Math.abs(Math.round(amount)).toLocaleString('en-US')}`;
  }

  return { roll, rarityOf, formatRubles, randInt };
});
