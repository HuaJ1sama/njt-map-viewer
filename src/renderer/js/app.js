'use strict';

(function () {
  const G = window.NJTGeom;
  const api = window.njt;
  const SVGNS = 'http://www.w3.org/2000/svg';

  const COLORS = ['#ffd166', '#ff6b6b', '#4dd4ac', '#5aa9ff', '#c792ea', '#ffffff'];
  const TASK_COLORS = ['#ffd166', '#ff8f5a', '#ff6b6b', '#c792ea', '#5aa9ff', '#4dd4ac', '#9ee37d', '#ffffff'];
  const WIDTHS = [2, 4, 7];
  const HINTS = {
    pan: '滚轮缩放，按住左键拖拽平移',
    select: '点选一条标注后可以拖动，Delete 删除',
    ellipse: '按住左键拖拽画圆',
    rect: '按住左键拖拽画方框',
    arrow: '按住左键从起点拖到终点画箭头',
    pen: '按住左键自由涂画',
  };
  const IDLE_DELAY = 2500;
  const HOTSPOT_PAD = 8;

  const el = {};
  const state = {
    config: null,
    defaults: {},
    overrides: {},
    annotations: { version: 1, maps: {} },
    view: 'overview',
    regionId: null,
    overviewMeta: null,
    imgW: 0,
    imgH: 0,
    transform: { s: 1, tx: 0, ty: 0 },
    minScale: 1,
    maxScale: 8,
    fitScale: 1,
    tool: 'pan',
    color: COLORS[0],
    width: WIDTHS[1],
    shapes: [],
    tasks: [],
    selectedShapeId: null,
    selectionEl: null,
    shapesVisible: true,
    history: [],
    future: [],
    elements: new Map(),
    taskElements: new Map(),
    framingTaskId: null,
    framingHistory: [],
    taskFormOpen: false,
    taskFormMode: 'create',
    editingTaskId: null,
    taskFormColor: TASK_COLORS[0],
    previewBox: null,
    hotspots: new Map(),
    pointers: { mode: null, lastX: 0, lastY: 0 },
    pendingBefore: null,
    calibration: false,
    drag: null,
    spacePan: false,
    clearArmed: 0,
  };

  const metaCache = new Map();
  let idleTimer = 0;
  let saveTimer = 0;
  let hotspotSaveTimer = 0;
  let toastTimer = 0;

  const deepCopy = (value) => JSON.parse(JSON.stringify(value));

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    }
    return node;
  }

  function assetUrl(relative) {
    return `njt://asset/${relative.split('/').map(encodeURIComponent).join('/')}`;
  }

  function mapUrl(fileName) {
    return `njt://map/${encodeURIComponent(fileName)}`;
  }

  /** 优先用 assets 里打包过的显示副本，没有才回退到原图目录。 */
  function regionSourceUrl(region) {
    return region.display ? assetUrl(region.display) : mapUrl(region.image);
  }

  function danceSourceUrl() {
    const extras = state.config.extras || {};
    if (extras.danceDisplay) return assetUrl(extras.danceDisplay);
    return extras.danceGif ? mapUrl(extras.danceGif) : '';
  }

  function getImageMeta(url) {
    if (metaCache.has(url)) return metaCache.get(url);
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ url, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error(`图片加载失败：${url}`));
      img.src = url;
    });
    metaCache.set(url, promise);
    return promise;
  }

  function showToast(message, duration = 1900) {
    el.toast.textContent = message;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), duration);
  }

  function viewportSize() {
    const rect = el.mapViewport.getBoundingClientRect();
    return { w: rect.width || 1, h: rect.height || 1 };
  }

  function viewportPoint(event) {
    const rect = el.mapViewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function regionById(id) {
    return state.config.regions.find((region) => region.id === id) || null;
  }

  function pokeToolbars() {
    document.body.classList.remove('ui-idle');
    clearTimeout(idleTimer);
    if (state.calibration || state.framingTaskId || state.taskFormOpen || scav.open || dance.open) return;
    idleTimer = setTimeout(() => {
      if (!state.calibration && !state.framingTaskId && !state.taskFormOpen && !scav.open && !dance.open) {
        document.body.classList.add('ui-idle');
      }
    }, IDLE_DELAY);
  }

  /* ---------------- 尼沙皇跳舞 ---------------- */

  const dance = { open: false };

  function danceGifUrl() {
    return danceSourceUrl();
  }

  function playDance() {
    const url = danceGifUrl();
    if (!url) {
      showToast('没有配置跳舞 GIF');
      return;
    }
    // 每次换一个地址，让浏览器从头开始播放
    el.danceGif.src = `${url}?t=${Date.now()}`;
  }

  function openDance() {
    dance.open = true;
    el.danceModal.classList.remove('hidden');
    clearTimeout(idleTimer);
    document.body.classList.remove('ui-idle');
    playDance();
  }

  function closeDance() {
    if (!dance.open) return;
    dance.open = false;
    el.danceModal.classList.add('hidden');
    el.danceGif.removeAttribute('src');
    pokeToolbars();
  }

  /* ---------------- scav 宝箱 ---------------- */

  const scav = { open: false, rollNo: 0, best: 0, last: null };
  const ui = { rightHidden: false };
  const prefs = { lastView: null, recentRegions: [], restoreLast: true };
  const overview = { s: 1, tx: 0, ty: 0, fit: 1, min: 1, max: 6 };
  const overviewPointer = { active: false, moved: false, lastX: 0, lastY: 0 };

  function savePrefs() {
    api.saveSettings({
      version: 1,
      rightPanelHidden: ui.rightHidden,
      lastView: prefs.lastView,
      recentRegions: prefs.recentRegions,
      restoreLast: prefs.restoreLast,
    });
  }

  function rememberRegion(regionId) {
    prefs.lastView = { type: 'map', regionId };
    prefs.recentRegions = [regionId, ...prefs.recentRegions.filter((id) => id !== regionId)].slice(0, 4);
    savePrefs();
    renderRecentBar();
  }

  function rememberOverview() {
    prefs.lastView = { type: 'overview' };
    savePrefs();
  }

  function renderRecentBar() {
    const ids = prefs.recentRegions.filter((id) => regionById(id));
    el.recentBar.classList.toggle('hidden', ids.length === 0);
    el.btnRecentToggle.classList.toggle('active', prefs.restoreLast);
    el.btnRecentToggle.title = prefs.restoreLast
      ? '启动时回到上次看的地方（已开启，点击关闭）'
      : '启动时回到上次看的地方（已关闭，点击开启）';
    el.recentList.textContent = '';
    for (const id of ids) {
      const region = regionById(id);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'recent-chip';
      chip.textContent = region.name;
      chip.dataset.id = id;
      chip.addEventListener('click', () => openRegion(id));
      el.recentList.append(chip);
    }
  }

  function toggleRestoreLast() {
    prefs.restoreLast = !prefs.restoreLast;
    savePrefs();
    renderRecentBar();
    showToast(prefs.restoreLast ? '启动时会回到上次看的地方' : '启动时回到大地图');
  }

  /** 把当前画面（隐藏界面元素后）复制到剪贴板。 */
  async function copyView() {
    document.body.classList.add('capture-mode');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const shot = await api.captureView();
      if (!shot || !shot.ok) throw new Error('截图失败');
      const blob = dataUrlToBlob(shot.dataUrl);
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } catch (error) {
        await legacyCopyImage(blob);
      }
      showToast(`已复制到剪贴板（${shot.size.width}×${shot.size.height}），直接粘贴即可`, 2600);
    } catch (error) {
      showToast(`复制失败：${error.message}`, 3000);
    } finally {
      document.body.classList.remove('capture-mode');
    }
  }

  /** data URL → Blob（不走 fetch，避免被 CSP 的 connect-src 拦下）。 */
  function dataUrlToBlob(dataUrl) {
    const [meta, base64] = dataUrl.split(',');
    const mime = (meta.match(/:(.*?);/) || [null, 'image/png'])[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }

  /** 老办法兜底：把图片放进可编辑区域再 execCommand('copy')。图片解码完再复制，否则剪贴板里是空的。 */
  async function legacyCopyImage(blob) {
    const url = URL.createObjectURL(blob);
    const holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;';
    const img = document.createElement('img');
    img.src = url;
    holder.append(img);
    document.body.append(holder);
    try {
      await img.decode();
    } catch {
      holder.remove();
      URL.revokeObjectURL(url);
      throw new Error('图片解码失败');
    }
    // 解码完还要等它真正画上去，否则 execCommand 复制到的只有标签没有图
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const range = document.createRange();
    range.selectNodeContents(holder);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand('copy');
    selection.removeAllRanges();
    holder.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (!ok) throw new Error('系统拒绝了复制操作');
  }
  // 启动动画整段约 15 秒，加载页一闪而过的话等于没播，所以保底停留这么久（可点击跳过）。
  const LOADING_MIN_VISIBLE_MS = 2400;
  const loading = { start: Date.now(), finished: false, skipRequested: false, hidden: false, hideTimer: null };

  function setLoading(percent, text) {
    if (!el.loadingFill) return;
    el.loadingFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (text) el.loadingText.textContent = text;
  }

  function hideLoading() {
    if (loading.hidden) return;
    loading.hidden = true;
    loading.hideTimer = null;
    el.loading.classList.add('done');
    setTimeout(() => el.loading.classList.add('hidden'), 460);
  }

  function finishLoading() {
    if (loading.finished) return;
    loading.finished = true;
    const minVisible = loading.skipRequested ? 0 : LOADING_MIN_VISIBLE_MS;
    const wait = Math.max(0, minVisible - (Date.now() - loading.start));
    loading.hideTimer = setTimeout(hideLoading, wait);
  }

  /** 单击加载页或按任意键：还没就绪就先记下，等就绪后立刻收起。 */
  function requestSkipLoading() {
    if (!el.loading || loading.hidden) return;
    if (!loading.finished) {
      loading.skipRequested = true;
      el.loadingHint.textContent = '就绪后立即进入…';
      return;
    }
    clearTimeout(loading.hideTimer);
    hideLoading();
  }

  function applyRightPanel() {
    document.body.classList.toggle('ui-right-hidden', ui.rightHidden);
    el.btnUiToggle.classList.toggle('active', ui.rightHidden);
    el.btnUiToggle.title = ui.rightHidden ? '显示右侧面板 (H)' : '隐藏右侧面板 (H)';
  }

  function toggleRightPanel(force) {
    ui.rightHidden = typeof force === 'boolean' ? force : !ui.rightHidden;
    applyRightPanel();
    savePrefs();
    if (!ui.rightHidden) pokeToolbars();
    showToast(ui.rightHidden ? '右侧面板已收起，按 H 或点右上角按钮可以调回来' : '右侧面板已显示');
  }

  function formatRubles(amount) {
    return window.NJTScav.formatRubles(amount);
  }

  function renderScavRoll(result) {
    el.scavLoot.textContent = '';
    for (const pick of result.picks) {
      const row = document.createElement('li');
      row.className = `scav-item rarity-${window.NJTScav.rarityOf(pick)}`;
      row.title = pick.qty > 1 ? `${pick.name} ×${pick.qty}（单价 ${formatRubles(pick.value)}）` : `${pick.name}（${formatRubles(pick.value)}）`;
      const category = document.createElement('span');
      category.className = 'scav-cat';
      category.textContent = pick.category;
      const name = document.createElement('span');
      name.className = 'scav-name';
      name.textContent = pick.qty > 1 ? `${pick.name} ×${pick.qty}` : pick.name;
      const unit = document.createElement('span');
      unit.className = 'scav-unit';
      unit.textContent = pick.qty > 1 ? `${formatRubles(pick.value)}/个` : '';
      const subtotal = document.createElement('span');
      subtotal.className = 'scav-subtotal';
      subtotal.textContent = formatRubles(pick.total);
      row.append(category, name, unit, subtotal);
      el.scavLoot.append(row);
    }
    el.scavTotal.textContent = formatRubles(result.total);
    const profitText = `${result.profit >= 0 ? '+' : '-'}${formatRubles(Math.abs(result.profit))}`;
    el.scavProfit.textContent = profitText;
    el.scavProfit.classList.toggle('up', result.profit >= 0);
    el.scavProfit.classList.toggle('down', result.profit < 0);
    el.scavRollNo.textContent = String(scav.rollNo);
    el.scavBest.textContent = formatRubles(scav.best);
    el.scavCost.textContent = formatRubles(result.cost);
  }

  function rollScav() {
    const result = window.NJTScav.roll(state.config.scav);
    scav.rollNo += 1;
    scav.best = Math.max(scav.best, result.total);
    scav.last = result;
    el.scavLoot.classList.add('rolling');
    setTimeout(() => el.scavLoot.classList.remove('rolling'), 240);
    renderScavRoll(result);
    return result;
  }

  function openScav() {
    scav.open = true;
    el.scavModal.classList.remove('hidden');
    clearTimeout(idleTimer);
    document.body.classList.remove('ui-idle');
    rollScav();
  }

  function closeScav() {
    if (!scav.open) return;
    scav.open = false;
    el.scavModal.classList.add('hidden');
    pokeToolbars();
  }

  /* ---------------- 大地图 ---------------- */

  function fitOverview() {
    const meta = state.overviewMeta;
    if (!meta) return;
    const rect = el.overviewViewport.getBoundingClientRect();
    el.overviewStage.style.width = `${meta.w}px`;
    el.overviewStage.style.height = `${meta.h}px`;
    const range = G.scaleRange(meta.w, meta.h, rect.width, rect.height);
    overview.fit = range.fit;
    overview.min = range.fit;
    overview.max = Math.max(6, range.fit);
    overview.s = range.fit;
    overview.tx = (rect.width - meta.w * range.fit) / 2;
    overview.ty = (rect.height - meta.h * range.fit) / 2;
    applyOverviewTransform();
    ensureHotspots();
  }

  function applyOverviewTransform() {
    el.overviewStage.style.transform = `translate(${overview.tx}px, ${overview.ty}px) scale(${overview.s})`;
  }

  function zoomOverviewAt(factor, clientX, clientY) {
    const meta = state.overviewMeta;
    if (!meta) return;
    const rect = el.overviewViewport.getBoundingClientRect();
    const next = G.zoomAt(
      { s: overview.s, tx: overview.tx, ty: overview.ty },
      factor,
      clientX - rect.left,
      clientY - rect.top,
      overview.min,
      overview.max,
    );
    const clamped = G.clampTranslation(next, meta.w, meta.h, rect.width, rect.height);
    overview.s = clamped.s;
    overview.tx = clamped.tx;
    overview.ty = clamped.ty;
    applyOverviewTransform();
  }

  function hotspotRadius() {
    return state.config.hotspotRadius || 22;
  }

  function labelTextWidth(text) {
    let width = 0;
    for (const char of text) width += char.charCodeAt(0) > 255 ? 22 : 11;
    return width;
  }

  function buildHotspotLabel(region, textOverride) {
    const group = svgEl('g', { class: 'label' });
    const padX = 11;
    const badgeText = region.badge ? `（${region.badge}）` : '';
    const labelText = textOverride || region.name;
    const width = padX * 2 + labelTextWidth(labelText) + (badgeText ? labelTextWidth(badgeText) - 6 : 0);
    const height = 32;
    group.append(svgEl('rect', { x: 0, y: -height / 2, width, height, rx: 7 }));
    const text = svgEl('text', { x: padX, y: 1 });
    text.textContent = labelText;
    group.append(text);
    if (badgeText) {
      const badge = svgEl('text', { x: padX + labelTextWidth(labelText) + 2, y: 1, class: 'badge-text' });
      badge.textContent = badgeText;
      group.append(badge);
    }
    group.dataset.width = String(width);
    return group;
  }

  function positionHotspot(region) {
    const entry = state.hotspots.get(region.id);
    if (!entry) return;
    const box = labelBox(region);
    entry.frame.setAttribute('x', box.x);
    entry.frame.setAttribute('y', box.y);
    entry.frame.setAttribute('width', box.w);
    entry.frame.setAttribute('height', box.h);
    entry.hit.setAttribute('x', box.x - HOTSPOT_PAD);
    entry.hit.setAttribute('y', box.y - HOTSPOT_PAD);
    entry.hit.setAttribute('width', box.w + HOTSPOT_PAD * 2);
    entry.hit.setAttribute('height', box.h + HOTSPOT_PAD * 2);
    if (entry.ring && entry.dot) {
      for (const node of [entry.ring, entry.dot]) {
        node.setAttribute('cx', box.cx);
        node.setAttribute('cy', box.cy);
      }
    }
    if (entry.label) {
      entry.label.setAttribute('transform', `translate(${(box.cx + hotspotRadius() + 10).toFixed(1)}, ${box.cy.toFixed(1)})`);
    }
  }

  /** 热区矩形：以地区图标为基准，覆盖原图上的地区文字（海关那种高亮框）。 */
  function labelBox(region) {
    const meta = state.overviewMeta || { w: 1260, h: 934 };
    const offset = Array.isArray(region.label) ? region.label : [-24, -22, 130, 44];
    const cx = region.hotspot[0] * meta.w;
    const cy = region.hotspot[1] * meta.h;
    return { cx, cy, x: cx + offset[0], y: cy + offset[1], w: offset[2], h: offset[3] };
  }

  function onHotspotPointerDown(event, region) {
    if (!state.calibration || event.button !== 0) return;
    event.preventDefault();
    try {
      el.overviewSvg.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件没有真实指针 */
    }
    state.drag = { id: region.id, moved: false };
    state.hotspots.get(region.id)?.group.classList.add('is-dragging');
    updateCalibrationList(region.id);
  }

  function createHotspot(region) {
    const group = svgEl('g', { class: `hotspot${region.custom ? ' is-custom' : ''}`, 'data-id': region.id });
    const frame = svgEl('rect', { class: 'frame', rx: 9, ry: 9 });
    const hit = svgEl('rect', { class: 'hit', rx: 12, ry: 12, fill: 'transparent', 'pointer-events': 'all' });
    const title = svgEl('title');
    title.textContent = region.badge ? `${region.name}（${region.badge}）` : region.name;
    group.append(title, frame);
    let ring = null;
    let dot = null;
    let label = tasksInRegion(region.id).length ? buildHotspotLabel(region, hotspotLabelText(region)) : null;
    if (region.custom) {
      ring = svgEl('circle', { class: 'ring', r: hotspotRadius() });
      dot = svgEl('circle', { class: 'dot', r: 8 });
      if (!label) label = buildHotspotLabel(region, hotspotLabelText(region));
      group.append(ring, dot, label);
    } else if (label) group.append(label);
    group.append(hit);
    group.addEventListener('pointerenter', () => group.classList.add('is-hover'));
    group.addEventListener('pointerleave', () => group.classList.remove('is-hover'));
    group.addEventListener('pointerdown', (event) => onHotspotPointerDown(event, region));
    group.addEventListener('click', () => {
      if (state.calibration || (state.drag && state.drag.moved) || overviewPointer.moved) return;
      openRegion(region.id);
    });
    el.overviewSvg.append(group);
    state.hotspots.set(region.id, { group, hit, frame, ring, dot, label });
    positionHotspot(region);
  }

  function hotspotLabelText(region) {
    const tasks = tasksInRegion(region.id);
    if (!tasks.length) return region.name;
    const names = tasks.slice(0, 2).map((task) => task.name).join('、');
    return `${region.name}（任务：${names}${tasks.length > 2 ? ` 等${tasks.length}个` : ''}）`;
  }

  function refreshHotspotLabels() {
    for (const region of state.config.regions) {
      const entry = state.hotspots.get(region.id);
      if (!entry) continue;
      const needsLabel = region.custom || tasksInRegion(region.id).length > 0;
      if (entry.label) {
        entry.label.remove();
        entry.label = null;
      }
      if (!needsLabel) continue;
      entry.label = buildHotspotLabel(region, hotspotLabelText(region));
      entry.group.append(entry.label);
      positionHotspot(region);
    }
  }

  function ensureHotspots() {
    if (!state.hotspots.size) renderHotspots();
  }

  function renderHotspots() {
    el.overviewHotspotLayer.textContent = '';
    state.hotspots.clear();
    for (const region of state.config.regions) createHotspot(region);
  }

  function buildCalibrationList() {
    el.calibrationList.textContent = '';
    for (const region of state.config.regions) {
      const item = document.createElement('li');
      item.dataset.id = region.id;
      const name = document.createElement('span');
      name.textContent = region.custom ? `${region.name}（新增）` : region.name;
      const code = document.createElement('code');
      code.textContent = `${region.hotspot[0].toFixed(4)}, ${region.hotspot[1].toFixed(4)}`;
      item.append(name, code);
      el.calibrationList.append(item);
    }
  }

  function updateCalibrationList(activeId) {
    for (const item of el.calibrationList.querySelectorAll('li')) {
      const region = regionById(item.dataset.id);
      if (!region) continue;
      item.classList.toggle('is-active', item.dataset.id === activeId);
      const code = item.querySelector('code');
      if (code) code.textContent = `${region.hotspot[0].toFixed(4)}, ${region.hotspot[1].toFixed(4)}`;
    }
  }

  function onOverviewPointerMove(event) {
    if (state.drag) {
      dragHotspot(event);
      return;
    }
    if (!overviewPointer.active || !state.overviewMeta) return;
    const dx = event.clientX - overviewPointer.lastX;
    const dy = event.clientY - overviewPointer.lastY;
    if (Math.hypot(dx, dy) > 3) overviewPointer.moved = true;
    overviewPointer.lastX = event.clientX;
    overviewPointer.lastY = event.clientY;
    if (!overviewPointer.moved || overview.s <= overview.min + 1e-6) return;
    const rect = el.overviewViewport.getBoundingClientRect();
    const next = G.clampTranslation(
      { s: overview.s, tx: overview.tx + dx, ty: overview.ty + dy },
      state.overviewMeta.w,
      state.overviewMeta.h,
      rect.width,
      rect.height,
    );
    overview.tx = next.tx;
    overview.ty = next.ty;
    applyOverviewTransform();
  }

  function onOverviewPointerDown(event) {
    if (state.drag) return;
    if (event.button !== 0 && event.button !== 1) return;
    overviewPointer.active = true;
    overviewPointer.moved = false;
    overviewPointer.lastX = event.clientX;
    overviewPointer.lastY = event.clientY;
    if (overview.s > overview.min + 1e-6) document.body.classList.add('is-panning');
  }

  function dragHotspot(event) {
    const region = regionById(state.drag.id);
    const meta = state.overviewMeta;
    const rect = el.overviewStage.getBoundingClientRect();
    if (!region || !meta || !rect.width || !rect.height) return;
    const nx = G.clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const ny = G.clamp((event.clientY - rect.top) / rect.height, 0, 1);
    region.hotspot = [Number(nx.toFixed(4)), Number(ny.toFixed(4))];
    state.drag.moved = true;
    positionHotspot(region);
    updateCalibrationList(region.id);
  }

  function onOverviewPointerUp() {
    document.body.classList.remove('is-panning');
    overviewPointer.active = false;
    if (state.drag) {
      const { id, moved } = state.drag;
      const region = regionById(id);
      state.hotspots.get(id)?.group.classList.remove('is-dragging');
      state.drag = null;
      if (moved && region) {
        state.overrides[region.id] = region.hotspot.slice();
        scheduleHotspotSave();
        showToast(`${region.name} 的位置已保存`);
      }
      return;
    }
  }

  function setCalibration(on) {
    state.calibration = on;
    el.calibrationPanel.classList.toggle('hidden', !on);
    el.btnCalibrate.classList.toggle('active', on);
    for (const entry of state.hotspots.values()) entry.group.classList.toggle('is-calibrating', on);
    if (on) {
      buildCalibrationList();
      clearTimeout(idleTimer);
      document.body.classList.remove('ui-idle');
    } else {
      pokeToolbars();
    }
  }

  function scheduleHotspotSave() {
    clearTimeout(hotspotSaveTimer);
    hotspotSaveTimer = setTimeout(() => {
      api.saveHotspots({ version: 1, space: state.config.overview.space, hotspots: state.overrides });
    }, 300);
  }

  function resetHotspots() {
    state.overrides = {};
    for (const region of state.config.regions) {
      region.hotspot = state.defaults[region.id].slice();
      positionHotspot(region);
    }
    updateCalibrationList(null);
    scheduleHotspotSave();
    showToast('已恢复默认位置');
  }

  async function initOverview() {
    const overview = state.config.overview;
    let meta = null;
    try {
      meta = await getImageMeta(assetUrl(overview.preview));
    } catch (error) {
      showToast(error.message);
    }
    state.overviewMeta = meta || { w: 1260, h: 934 };
    el.overviewSvg.setAttribute('viewBox', `0 0 ${state.overviewMeta.w} ${state.overviewMeta.h}`);
    el.overviewSvg.setAttribute('preserveAspectRatio', 'none');
    el.overviewImg.addEventListener(
      'error',
      () => {
        el.overviewImg.src = assetUrl(overview.preview);
      },
      { once: true },
    );
    el.overviewImg.src = assetUrl(overview.display);
    el.overviewBackdrop.style.backgroundImage = `url("${assetUrl(overview.display)}")`;
    setLoading(88, '正在加载大地图…');
    await Promise.race([waitImage(el.overviewImg, 9000), new Promise((resolve) => setTimeout(resolve, 9000))]);
    setLoading(96, '正在布置地区热点…');
    renderHotspots();
    fitOverview();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    setLoading(100, '准备完成');
  }

  /* ---------------- 缩放平移 ---------------- */

  function setStageSize(width, height) {
    state.imgW = width;
    state.imgH = height;
    el.mapStage.style.width = `${width}px`;
    el.mapStage.style.height = `${height}px`;
    el.mapSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    el.mapSvg.setAttribute('preserveAspectRatio', 'none');
  }

  function refreshScaleRange() {
    const { w, h } = viewportSize();
    const range = G.scaleRange(state.imgW, state.imgH, w, h);
    state.fitScale = range.fit;
    state.minScale = range.min;
    state.maxScale = range.max;
    return { w, h };
  }

  function applyTransform() {
    const { s, tx, ty } = state.transform;
    el.mapStage.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    updateScaleDependentStyles();
    el.zoomReadout.textContent = `${Math.round(s * 100)}%`;
  }

  function fitView() {
    const { w, h } = refreshScaleRange();
    state.transform = G.clampTranslation(G.fitTransform(state.imgW, state.imgH, w, h), state.imgW, state.imgH, w, h);
    applyTransform();
  }

  function zoomBy(factor, cx, cy) {
    if (!state.imgW) return;
    const { w, h } = viewportSize();
    const px = typeof cx === 'number' ? cx : w / 2;
    const py = typeof cy === 'number' ? cy : h / 2;
    const next = G.zoomAt(state.transform, factor, px, py, state.minScale, state.maxScale);
    state.transform = G.clampTranslation(next, state.imgW, state.imgH, w, h);
    applyTransform();
  }

  function zoomToScale(scale) {
    if (!state.imgW) return;
    const { w, h } = viewportSize();
    const center = G.screenToImage(w / 2, h / 2, state.transform);
    const target = G.clamp(scale, state.minScale, state.maxScale);
    state.transform = G.clampTranslation(
      { s: target, tx: w / 2 - center.x * target, ty: h / 2 - center.y * target },
      state.imgW,
      state.imgH,
      w,
      h,
    );
    applyTransform();
  }

  function refitMap() {
    if (state.view !== 'map' || !state.imgW) return;
    const { w, h } = viewportSize();
    const oldFit = state.fitScale;
    const oldScale = state.transform.s;
    refreshScaleRange();
    if (Math.abs(oldScale - oldFit) < 1e-6) {
      state.transform = G.fitTransform(state.imgW, state.imgH, w, h);
    } else {
      const center = G.screenToImage(w / 2, h / 2, state.transform);
      const scale = G.clamp(oldScale, state.minScale, state.maxScale);
      state.transform = { s: scale, tx: w / 2 - center.x * scale, ty: h / 2 - center.y * scale };
    }
    state.transform = G.clampTranslation(state.transform, state.imgW, state.imgH, w, h);
    applyTransform();
  }

  /* ---------------- 标注 ---------------- */

  function imagePoints(shape) {
    return shape.points.map((pt) => ({ x: pt[0] * state.imgW, y: pt[1] * state.imgH }));
  }

  function buildShapeElement(shape) {
    const points = imagePoints(shape);
    let node;
    if (shape.type === 'rect') {
      const r = G.rectFromPoints(points[0], points[1]);
      node = svgEl('rect', { x: r.x, y: r.y, width: r.w, height: r.h });
    } else if (shape.type === 'ellipse') {
      const e = G.ellipseFromPoints(points[0], points[1]);
      node = svgEl('ellipse', { cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry });
    } else if (shape.type === 'arrow') {
      node = svgEl('g', {});
      node.append(svgEl('line', { x1: points[0].x, y1: points[0].y, x2: points[1].x, y2: points[1].y }));
      node.append(svgEl('polygon', { stroke: 'none' }));
    } else {
      node = svgEl('path', { d: G.pathFromPoints(points), 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    }
    if (shape.type !== 'arrow') node.setAttribute('fill', 'none');
    node.setAttribute('stroke', shape.color);
    node.setAttribute('data-shape-id', shape.id);
    return node;
  }

  function renderShapes() {
    el.shapeLayer.textContent = '';
    state.elements.clear();
    state.selectionEl = null;
    for (const shape of state.shapes) {
      const node = buildShapeElement(shape);
      el.shapeLayer.append(node);
      state.elements.set(shape.id, node);
    }
    updateScaleDependentStyles();
    updateSelectionBox();
  }

  function selectedShape() {
    return state.shapes.find((shape) => shape.id === state.selectedShapeId) || null;
  }

  function setSelection(shapeId) {
    state.selectedShapeId = shapeId;
    updateSelectionBox();
    el.btnDeleteShape.disabled = !selectedShape();
  }

  /** 选中态用一圈虚线框表示，不改变标注本身的颜色。 */
  function updateSelectionBox() {
    if (state.selectionEl) {
      state.selectionEl.remove();
      state.selectionEl = null;
    }
    const shape = selectedShape();
    if (!shape || !state.shapesVisible || state.view !== 'map' || !state.imgW) {
      el.btnDeleteShape.disabled = !shape;
      return;
    }
    const bounds = G.shapeBounds(shape, state.imgW, state.imgH);
    const pad = 7 / (state.transform.s || 1);
    const node = svgEl('rect', {
      class: 'selection-box',
      x: bounds.x - pad,
      y: bounds.y - pad,
      width: Math.max(bounds.w + pad * 2, pad * 3),
      height: Math.max(bounds.h + pad * 2, pad * 3),
      rx: 4 / (state.transform.s || 1),
    });
    el.shapeLayer.append(node);
    state.selectionEl = node;
    el.btnDeleteShape.disabled = false;
  }

  function hitTestShape(imagePoint) {
    const tolerance = 10 / (state.transform.s || 1);
    const near = [];
    const inside = [];
    for (const shape of state.shapes) {
      const distance = G.distanceToShape(imagePoint, shape, state.imgW, state.imgH);
      if (distance <= tolerance) near.push({ shape, distance });
      else if (G.pointInShape(imagePoint, shape, state.imgW, state.imgH)) inside.push(shape);
    }
    if (near.length) return near.sort((a, b) => a.distance - b.distance)[0].shape;
    return inside.length ? inside[inside.length - 1] : null;
  }

  function deleteSelectedShape() {
    const shape = selectedShape();
    if (!shape) return;
    const before = snapshot();
    state.shapes = state.shapes.filter((item) => item.id !== shape.id);
    state.selectedShapeId = null;
    renderShapes();
    commitChange(before);
    persistNow();
    showToast('已删除选中的标注');
  }

  function toggleShapeLayer() {
    state.shapesVisible = !state.shapesVisible;
    el.shapeLayer.classList.toggle('is-hidden', !state.shapesVisible);
    el.btnShapeVisible.classList.toggle('active', !state.shapesVisible);
    el.btnShapeVisible.title = state.shapesVisible ? '隐藏全部标注（数据还在）' : '显示全部标注';
    updateSelectionBox();
  }

  function renderShape(shape) {
    const previous = state.elements.get(shape.id);
    const node = buildShapeElement(shape);
    if (previous && previous.parentNode) previous.replaceWith(node);
    else el.shapeLayer.append(node);
    state.elements.set(shape.id, node);
    updateScaleDependentStyles();
  }

  /* ---------------- 任务框 ---------------- */

  function taskById(id) {
    return state.tasks.find((task) => task.id === id) || null;
  }

  function normalizeTask(task) {
    if (!Array.isArray(task.boxes)) task.boxes = [];
    if (typeof task.labels !== 'boolean') task.labels = true;
    if (!task.color) task.color = TASK_COLORS[0];
    if (typeof task.note !== 'string') task.note = '';
    task.boxes = task.boxes
      .filter((box) => Array.isArray(box.rect) && box.rect.length === 4)
      .map((box) => ({ ...box, done: box.done === true, regionId: box.regionId || null }));
    return task;
  }

  /** 老格式（任务存在各张地图下）迁移成全局任务表，每个框记住自己属于哪张图。 */
  function migrateTasks(annotations) {
    const tasks = [];
    const seen = new Set();
    if (Array.isArray(annotations.tasks)) {
      for (const task of annotations.tasks) {
        const normalized = normalizeTask(task);
        seen.add(normalized.id);
        tasks.push(normalized);
      }
    }
    let migrated = false;
    if (annotations.maps && typeof annotations.maps === 'object') {
      for (const [regionId, entry] of Object.entries(annotations.maps)) {
        if (!entry || !Array.isArray(entry.tasks)) continue;
        migrated = true;
        for (const raw of entry.tasks) {
          const task = normalizeTask(deepCopy(raw));
          task.boxes = task.boxes.map((box) => ({ ...box, regionId: box.regionId || regionId }));
          if (seen.has(task.id)) continue;
          seen.add(task.id);
          tasks.push(task);
        }
        delete entry.tasks;
      }
    }
    if (tasks.length || migrated) annotations.version = 2;
    return { tasks, migrated };
  }

  function tasksInRegion(regionId) {
    return state.tasks.filter((task) => task.boxes.some((box) => box.regionId === regionId));
  }

  function taskLabelText(task) {
    return task.note ? `${task.name}（${task.note}）` : task.name;
  }

  function estimateTextWidth(text, fontSize) {
    let width = 0;
    for (const char of String(text)) width += char.charCodeAt(0) > 255 ? fontSize : fontSize * 0.56;
    return width;
  }

  function buildTaskElement(task, box) {
    const width = state.imgW;
    const height = state.imgH;
    const x = box.rect[0] * width;
    const y = box.rect[1] * height;
    const w = box.rect[2] * width;
    const h = box.rect[3] * height;
    const group = svgEl('g', { class: 'task-box', 'data-task-id': task.id, 'data-box-id': box.id });
    const isDone = box.done === true;
    const frame = svgEl('rect', {
      class: `task-frame${isDone ? ' is-done' : ''}`,
      x,
      y,
      width: w,
      height: h,
      rx: 6,
      fill: isDone ? '#8f979f' : task.color,
      'fill-opacity': isDone ? 0.13 : 0.16,
      stroke: isDone ? '#9aa2ab' : task.color,
    });
    group.append(frame);
    if (task.labels !== false && task.name) {
      const label = svgEl('g', { class: 'task-label' });
      const bg = svgEl('rect', { class: 'task-label-bg', rx: 5, fill: task.color, 'fill-opacity': 0.95 });
      const text = svgEl('text');
      text.textContent = `${isDone ? '✓ ' : ''}${taskLabelText(task)}`;
      if (isDone) label.setAttribute('opacity', '0.62');
      label.append(bg, text);
      group.append(label);
    }
    return group;
  }

  function renderTasks() {
    el.taskLayer.textContent = '';
    state.taskElements.clear();
    for (const task of state.tasks) {
      for (const box of task.boxes) {
        if (box.regionId && state.regionId && box.regionId !== state.regionId) continue;
        const node = buildTaskElement(task, box);
        el.taskLayer.append(node);
        state.taskElements.set(box.id, { node, task, box });
      }
    }
    updateScaleDependentStyles();
    updateOverviewTaskBadges();
  }

  /** 大地图上给有任务的地区加彩色圆点徽标。 */
  function updateOverviewTaskBadges() {
    if (!el.overviewTaskLayer || !state.overviewMeta) return;
    el.overviewTaskLayer.textContent = '';
    refreshHotspotLabels();
    for (const region of state.config.regions) {
      const tasks = tasksInRegion(region.id);
      if (!tasks.length) continue;
      const cx = region.hotspot[0] * state.overviewMeta.w;
      const box = labelBox(region);
      const dotRadius = 8;
      const gap = 20;
      const startX = box.x + dotRadius;
      const y = box.y - 13;
      tasks.slice(0, 4).forEach((task, index) => {
        el.overviewTaskLayer.append(
          svgEl('circle', {
            cx: startX + index * gap,
            cy: y,
            r: dotRadius,
            fill: task.color,
            stroke: 'rgba(6,8,11,0.85)',
            'stroke-width': 2,
          }),
        );
      });
      if (tasks.length > 4) {
        const text = svgEl('text', { x: startX + 4 * gap, y: y + 5, fill: '#e9e5dd', 'font-size': 16 });
        text.textContent = `+${tasks.length - 4}`;
        el.overviewTaskLayer.append(text);
      }
    }
  }

  function layoutTaskLabel(entry, scale) {
    const label = entry.node.querySelector('.task-label');
    if (!label) return;
    const x = entry.box.rect[0] * state.imgW;
    const y = entry.box.rect[1] * state.imgH;
    const fontSize = 13 / scale;
    const padX = 7 / scale;
    const padY = 4 / scale;
    const textWidth = estimateTextWidth(taskLabelText(entry.task), 13) / scale;
    const labelHeight = fontSize * 1.05 + padY * 2;
    const text = label.querySelector('text');
    const bg = label.querySelector('.task-label-bg');
    text.setAttribute('font-size', fontSize);
    text.setAttribute('x', padX);
    text.setAttribute('y', padY + fontSize * 0.82);
    bg.setAttribute('width', textWidth + padX * 2);
    bg.setAttribute('height', labelHeight);
    const above = y - labelHeight - 3 / scale;
    const top = above >= 0 ? above : y + 3 / scale;
    label.setAttribute('transform', `translate(${x.toFixed(2)}, ${top.toFixed(2)})`);
  }

  function updateTaskPanel() {
    const hasTasks = state.tasks.length > 0;
    el.taskPanel.classList.toggle('is-empty', !hasTasks && !state.taskFormOpen);
    el.btnTaskLabels.classList.toggle('hidden', !hasTasks);
    el.taskList.textContent = '';
    for (const task of state.tasks) {
      const row = document.createElement('li');
      row.className = 'task-row';
      row.dataset.id = task.id;
      if (task.id === state.framingTaskId) row.classList.add('is-active');
      if (task.labels === false) row.classList.add('is-hidden');
      row.title = '点击整行可显示 / 隐藏该任务的名称';
      const dot = document.createElement('span');
      dot.className = 'task-dot';
      dot.style.background = task.color;
      const textWrap = document.createElement('span');
      textWrap.className = 'task-text';
      const name = document.createElement('span');
      name.className = 'task-name';
      name.textContent = task.name;
      textWrap.append(name);
      if (task.note) {
        const note = document.createElement('span');
        note.className = 'task-note';
        note.textContent = `（${task.note}）`;
        textWrap.append(note);
      }
      const count = document.createElement('span');
      count.className = 'task-count';
      const doneCount = task.boxes.filter((box) => box.done).length;
      count.textContent = doneCount ? `${doneCount}/${task.boxes.length} ✓` : `${task.boxes.length}处`;
      const regionSummary = Object.entries(
        task.boxes.reduce((acc, box) => {
          const id = box.regionId || 'unknown';
          acc[id] = (acc[id] || 0) + 1;
          return acc;
        }, {}),
      )
        .map(([id, total]) => {
          const region = regionById(id);
          return `${region ? region.name : id} ${total}处`;
        })
        .join(' · ');
      count.title = `共 ${task.boxes.length} 处，已完成 ${doneCount} 处${regionSummary ? `\n${regionSummary}` : ''}`;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn btn-icon task-btn';
      edit.textContent = '✎';
      edit.title = '编辑名称 / 备注 / 颜色';
      const frame = document.createElement('button');
      frame.type = 'button';
      frame.className = 'btn btn-icon task-btn';
      frame.textContent = '▣';
      frame.title = '继续框选地点';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-icon task-btn';
      remove.textContent = '✕';
      remove.title = '删除任务';
      row.append(dot, textWrap, count, frame, edit, remove);
      row.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        toggleTaskLabels(task.id);
      });
      frame.addEventListener('click', () => startFraming(task.id));
      edit.addEventListener('click', () => openTaskForm(true, { mode: 'edit', taskId: task.id }));
      remove.addEventListener('click', () => requestDeleteTask(task, remove));
      el.taskList.append(row);
    }
    el.btnTaskAdd.classList.toggle('framing', Boolean(state.framingTaskId));
    el.btnTaskAdd.textContent = state.framingTaskId ? '✓ 完成框选' : '＋';
    el.btnTaskAdd.title = state.framingTaskId ? '结束框选' : '添加任务';
    el.btnTaskUndo.classList.toggle('hidden', !state.framingTaskId);
    el.btnTaskUndo.disabled = state.framingHistory.length === 0;
    el.taskForm.classList.toggle('hidden', !state.taskFormOpen);
    const framing = taskById(state.framingTaskId);
    if (framing) {
      el.taskHint.classList.remove('hidden');
      el.taskHint.textContent = `正在框选「${framing.name}」：在地图上拖拽框出地点，可连框多个；单击已有的框可删掉它；Enter 或上面的按钮结束。`;
    } else {
      el.taskHint.classList.add('hidden');
    }
  }

  function buildTaskColorButtons() {
    el.taskColors.textContent = '';
    for (const color of TASK_COLORS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset.color = color;
      button.style.background = color;
      button.title = `任务颜色 ${color}`;
      button.addEventListener('click', () => {
        state.taskFormColor = color;
        for (const other of el.taskColors.querySelectorAll('.swatch')) {
          other.classList.toggle('active', other.dataset.color === color);
        }
      });
      if (color === state.taskFormColor) button.classList.add('active');
      el.taskColors.append(button);
    }
  }

  function openTaskForm(open, options) {
    state.taskFormOpen = open;
    if (open) {
      state.taskFormMode = (options && options.mode) || 'create';
      state.editingTaskId = (options && options.taskId) || null;
      const task = state.editingTaskId ? taskById(state.editingTaskId) : null;
      state.taskFormColor = task ? task.color : TASK_COLORS[0];
      el.taskName.value = task ? task.name : '';
      el.taskNote.value = task ? task.note || '' : '';
      el.btnTaskCreate.textContent = task ? '保存' : '开始框选';
      buildTaskColorButtons();
      el.taskName.focus();
    } else {
      state.taskFormMode = 'create';
      state.editingTaskId = null;
    }
    updateTaskPanel();
  }

  function createTask(name, color, note) {
    const task = normalizeTask({
      id: G.uid(),
      name: (name || '').trim() || `任务 ${state.tasks.length + 1}`,
      note: (note || '').trim(),
      color: color || state.taskFormColor,
      labels: true,
      boxes: [],
    });
    const before = snapshot();
    state.tasks.push(task);
    commitChange(before);
    startFraming(task.id);
    return task;
  }

  function updateTask(taskId, changes) {
    const task = taskById(taskId);
    if (!task) return null;
    const before = snapshot();
    if (typeof changes.name === 'string' && changes.name.trim()) task.name = changes.name.trim();
    if (typeof changes.note === 'string') task.note = changes.note.trim();
    if (changes.color) task.color = changes.color;
    renderTasks();
    updateTaskPanel();
    commitChange(before);
    persistNow();
    showToast(`已更新任务「${task.name}」`);
    return task;
  }

  function pushFramingHistory(task) {
    if (!task || state.framingTaskId !== task.id) return;
    state.framingHistory.push(deepCopy(task.boxes));
    if (state.framingHistory.length > 50) state.framingHistory.shift();
  }

  function addTaskBox(task, rect) {
    const before = snapshot();
    pushFramingHistory(task);
    task.boxes.push({
      id: G.uid(),
      regionId: state.regionId,
      done: false,
      rect: rect.map((value) => Number(value.toFixed(5))),
    });
    renderTasks();
    updateTaskPanel();
    commitChange(before);
    persistNow();
    return task.boxes[task.boxes.length - 1];
  }

  /** 点一下框把它标成已完成 / 未完成。 */
  function toggleBoxDone(task, boxId) {
    const box = task.boxes.find((item) => item.id === boxId);
    if (!box) return null;
    const before = snapshot();
    box.done = !box.done;
    renderTasks();
    updateTaskPanel();
    commitChange(before);
    persistNow();
    const doneCount = task.boxes.filter((item) => item.done).length;
    showToast(`「${task.name}」已完成 ${doneCount}/${task.boxes.length} 处`);
    return box;
  }

  function taskBoxAtPoint(norm) {
    for (const task of state.tasks) {
      for (const box of task.boxes) {
        if (box.regionId && box.regionId !== state.regionId) continue;
        if (
          norm[0] >= box.rect[0] &&
          norm[0] <= box.rect[0] + box.rect[2] &&
          norm[1] >= box.rect[1] &&
          norm[1] <= box.rect[1] + box.rect[3]
        ) {
          return { task, box };
        }
      }
    }
    return null;
  }

  function removeTaskBox(task, boxId) {
    const index = task.boxes.findIndex((box) => box.id === boxId);
    if (index < 0) return;
    const before = snapshot();
    pushFramingHistory(task);
    task.boxes.splice(index, 1);
    renderTasks();
    updateTaskPanel();
    commitChange(before);
    persistNow();
  }

  function startFraming(taskId) {
    const task = taskById(taskId);
    if (!task) return;
    state.framingTaskId = task.id;
    state.framingHistory = [];
    document.body.classList.add('is-framing');
    clearTimeout(idleTimer);
    document.body.classList.remove('ui-idle');
    openTaskForm(false);
    updateTaskPanel();
  }

  function stopFraming(message) {
    const task = taskById(state.framingTaskId);
    state.framingTaskId = null;
    state.framingHistory = [];
    state.previewBox = null;
    document.body.classList.remove('is-framing', 'is-drawing');
    el.taskLayer.querySelectorAll('.task-frame.preview').forEach((node) => node.remove());
    updateTaskPanel();
    pokeToolbars();
    if (task) showToast(message || `${task.name}：共框选 ${task.boxes.length} 处地点`);
    persistNow();
  }

  function toggleTaskLabels(taskId) {
    const task = taskById(taskId);
    if (!task) return;
    task.labels = task.labels === false;
    renderTasks();
    updateTaskPanel();
    persistNow();
    showToast(`${task.name} 的名称已${task.labels ? '显示' : '隐藏'}`);
  }

  function toggleAllTaskLabels() {
    if (!state.tasks.length) return;
    const anyHidden = state.tasks.some((task) => task.labels === false);
    for (const task of state.tasks) task.labels = anyHidden;
    renderTasks();
    updateTaskPanel();
    persistNow();
    showToast(anyHidden ? '已显示全部任务名称' : '已隐藏全部任务名称');
  }

  function deleteTask(taskId) {
    const task = taskById(taskId);
    if (!task) return;
    const before = snapshot();
    if (state.framingTaskId === task.id) {
      state.framingTaskId = null;
      document.body.classList.remove('is-framing');
    }
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    renderTasks();
    updateTaskPanel();
    commitChange(before);
    persistNow();
    showToast(`已删除任务「${task.name}」`);
  }

  /** 框选过程中的撤销：只回退当前任务刚刚框（或删）的那一步。 */
  function undoFraming() {
    const task = taskById(state.framingTaskId);
    if (!task || !state.framingHistory.length) {
      showToast('没有可撤销的框选了');
      return;
    }
    const before = snapshot();
    task.boxes = state.framingHistory.pop();
    renderTasks();
    updateTaskPanel();
    commitChange(before);
    persistNow();
    showToast(`已撤销一步：${task.name} 现在 ${task.boxes.length} 处`);
  }

  function requestDeleteTask(task, button) {
    if (button.dataset.armed === '1') {
      deleteTask(task.id);
      return;
    }
    button.dataset.armed = '1';
    button.classList.add('danger');
    button.textContent = '确认';
    setTimeout(() => {
      button.dataset.armed = '';
      button.classList.remove('danger');
      button.textContent = '✕';
    }, 2600);
  }

  /** 描边用屏幕像素宽度，除以当前缩放换算成图像坐标，缩放时线条粗细保持不变。 */
  function updateScaleDependentStyles() {
    const scale = state.transform.s || 1;
    for (const shape of state.shapes) {
      const node = state.elements.get(shape.id);
      if (!node) continue;
      const userWidth = shape.width / scale;
      if (shape.type === 'arrow') {
        const points = imagePoints(shape);
        const line = node.querySelector('line');
        const polygon = node.querySelector('polygon');
        if (line) line.setAttribute('stroke-width', userWidth);
        const head = G.arrowHead(points[0], points[1], shape.width, scale);
        if (polygon && head) {
          polygon.setAttribute('points', head.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '));
          polygon.setAttribute('fill', shape.color);
        }
      } else {
        node.setAttribute('stroke-width', userWidth);
      }
    }
    for (const entry of state.taskElements.values()) {
      const frame = entry.node.querySelector('.task-frame');
      if (frame) {
        frame.setAttribute('stroke-width', 2 / scale);
        if (frame.classList.contains('is-done')) frame.setAttribute('stroke-dasharray', `${6 / scale} ${4 / scale}`);
      }
      layoutTaskLabel(entry, scale);
    }
    const preview = el.taskLayer.querySelector('.task-frame.preview');
    if (preview) preview.setAttribute('stroke-width', 2 / scale);
    if (state.selectionEl) {
      state.selectionEl.setAttribute('stroke-width', 1.5 / scale);
      state.selectionEl.setAttribute('stroke-dasharray', `${7 / scale} ${5 / scale}`);
    }
  }

  function updateHistoryButtons() {
    el.btnUndo.disabled = state.history.length === 0;
    el.btnRedo.disabled = state.future.length === 0;
  }

  function snapshot() {
    return { shapes: deepCopy(state.shapes), tasks: deepCopy(state.tasks) };
  }

  function restore(snap) {
    const data = snap || { shapes: [], tasks: [] };
    state.shapes = data.shapes || [];
    state.tasks = (data.tasks || []).map(normalizeTask);
    renderShapes();
    renderTasks();
    updateTaskPanel();
  }

  function schedulePersist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistNow();
    }, 400);
  }

  async function persistNow() {
    clearTimeout(saveTimer);
    if (!state.annotations.maps) state.annotations.maps = {};
    if (state.regionId) {
      if (state.shapes.length) state.annotations.maps[state.regionId] = { shapes: deepCopy(state.shapes) };
      else delete state.annotations.maps[state.regionId];
    }
    state.annotations.version = 2;
    if (state.tasks.length) state.annotations.tasks = deepCopy(state.tasks);
    else delete state.annotations.tasks;
    return api.saveAnnotations(state.annotations);
  }

  function commitChange(before) {
    state.history.push(before);
    if (state.history.length > 100) state.history.shift();
    state.future = [];
    updateHistoryButtons();
    schedulePersist();
  }

  function undo() {
    if (!state.history.length) return;
    state.future.push(snapshot());
    restore(state.history.pop());
    updateHistoryButtons();
    persistNow();
  }

  function redo() {
    if (!state.future.length) return;
    state.history.push(snapshot());
    restore(state.future.pop());
    updateHistoryButtons();
    persistNow();
  }

  function resetClearButton() {
    state.clearArmed = 0;
    el.btnClear.classList.remove('active');
    el.btnClear.textContent = '清空';
  }

  function clearShapes() {
    if (!state.shapes.length) {
      showToast('当前地图还没有标注');
      return;
    }
    if (!state.clearArmed) {
      state.clearArmed = Date.now();
      el.btnClear.classList.add('active');
      el.btnClear.textContent = '再点一次清空';
      showToast('再点一次「清空」就会删除当前地图的全部标注', 2600);
      setTimeout(resetClearButton, 2600);
      return;
    }
    resetClearButton();
    const before = snapshot();
    state.shapes = [];
    renderShapes();
    commitChange(before);
    persistNow();
    showToast('已清空当前地图的标注');
  }

  function addShape(shape) {
    const before = snapshot();
    state.shapes.push(shape);
    renderShapes();
    commitChange(before);
    persistNow();
    return shape;
  }

  function shapeFromTool(type, fromNorm, toNorm) {
    return { id: G.uid(), type, color: state.color, width: state.width, points: [fromNorm, toNorm] };
  }

  function screenDistance(shape) {
    const points = imagePoints(shape);
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return total * state.transform.s;
  }

  /* ---------------- 指针交互 ---------------- */

  function onMapPointerDown(event) {
    if (state.view !== 'map' || !state.imgW) return;
    const pos = viewportPoint(event);
    const forcePan = event.button === 1 || state.spacePan;
    const wantsPan = forcePan || (!state.framingTaskId && state.tool === 'pan');
    try {
      el.mapViewport.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件没有真实指针，忽略即可 */
    }
    if (wantsPan) {
      const image = G.screenToImage(pos.x, pos.y, state.transform);
      const norm = G.toNorm(image.x, image.y, state.imgW, state.imgH);
      const hit = state.framingTaskId ? null : taskBoxAtPoint(norm);
      state.pointers = {
        mode: 'pan',
        lastX: pos.x,
        lastY: pos.y,
        moved: false,
        boxHit: hit ? { taskId: hit.task.id, boxId: hit.box.id } : null,
      };
      document.body.classList.add('is-panning');
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    if (state.framingTaskId) {
      startTaskBox(pos);
      event.preventDefault();
      return;
    }
    if (state.tool === 'select') {
      const image = G.screenToImage(pos.x, pos.y, state.transform);
      const hit = hitTestShape(image);
      setSelection(hit ? hit.id : null);
      if (hit) {
        const norm = G.toNorm(image.x, image.y, state.imgW, state.imgH);
        state.pendingBefore = snapshot();
        state.pointers = {
          mode: 'move-shape',
          shapeId: hit.id,
          startNorm: norm,
          originPoints: hit.points.map((point) => point.slice()),
          lastX: pos.x,
          lastY: pos.y,
        };
        document.body.classList.add('is-moving-shape');
      } else {
        state.pointers = { mode: null, lastX: 0, lastY: 0 };
      }
      event.preventDefault();
      return;
    }
    const image = G.screenToImage(pos.x, pos.y, state.transform);
    const norm = G.toNorm(image.x, image.y, state.imgW, state.imgH);
    state.pendingBefore = deepCopy(state.shapes);
    const shape = shapeFromTool(state.tool, norm, norm);
    shape.preview = true;
    state.shapes.push(shape);
    renderShape(shape);
    state.pointers = { mode: 'draw', lastX: pos.x, lastY: pos.y };
    document.body.classList.add('is-drawing');
    event.preventDefault();
  }

  function normRect(a, b) {
    return [
      Number(Math.min(a[0], b[0]).toFixed(5)),
      Number(Math.min(a[1], b[1]).toFixed(5)),
      Number(Math.abs(b[0] - a[0]).toFixed(5)),
      Number(Math.abs(b[1] - a[1]).toFixed(5)),
    ];
  }

  function startTaskBox(pos) {
    const task = taskById(state.framingTaskId);
    if (!task) return;
    const image = G.screenToImage(pos.x, pos.y, state.transform);
    const norm = G.toNorm(image.x, image.y, state.imgW, state.imgH);
    state.previewBox = { taskId: task.id, start: norm, current: norm, moved: false };
    state.pointers = { mode: 'framebox', lastX: pos.x, lastY: pos.y };
    document.body.classList.add('is-drawing');
  }

  function updatePreviewBox(rect, color) {
    let node = el.taskLayer.querySelector('.task-frame.preview');
    if (!node) {
      node = svgEl('rect', { class: 'task-frame preview', rx: 6, 'fill-opacity': 0.16, 'stroke-width': 2 / state.transform.s });
      el.taskLayer.append(node);
    }
    node.setAttribute('x', rect[0] * state.imgW);
    node.setAttribute('y', rect[1] * state.imgH);
    node.setAttribute('width', rect[2] * state.imgW);
    node.setAttribute('height', rect[3] * state.imgH);
    node.setAttribute('fill', color);
    node.setAttribute('stroke', color);
  }

  function taskBoxAt(task, normPoint) {
    return (
      task.boxes.find(
        (box) =>
          normPoint[0] >= box.rect[0] &&
          normPoint[0] <= box.rect[0] + box.rect[2] &&
          normPoint[1] >= box.rect[1] &&
          normPoint[1] <= box.rect[1] + box.rect[3],
      ) || null
    );
  }

  function onMapPointerMove(event) {
    if (!state.pointers.mode) return;
    const pos = viewportPoint(event);
    if (state.pointers.mode === 'pan') {
      const dx = pos.x - state.pointers.lastX;
      const dy = pos.y - state.pointers.lastY;
      state.pointers.lastX = pos.x;
      state.pointers.lastY = pos.y;
      if (Math.hypot(dx, dy) > 3) state.pointers.moved = true;
      const { w, h } = viewportSize();
      state.transform = G.clampTranslation(
        { s: state.transform.s, tx: state.transform.tx + dx, ty: state.transform.ty + dy },
        state.imgW,
        state.imgH,
        w,
        h,
      );
      applyTransform();
      return;
    }
    if (state.pointers.mode === 'move-shape') {
      const shape = state.shapes.find((item) => item.id === state.pointers.shapeId);
      if (!shape) return;
      const image = G.screenToImage(pos.x, pos.y, state.transform);
      const norm = G.toNorm(image.x, image.y, state.imgW, state.imgH);
      const dx = norm[0] - state.pointers.startNorm[0];
      const dy = norm[1] - state.pointers.startNorm[1];
      shape.points = state.pointers.originPoints.map((point) => point.slice());
      G.translateShape(shape, dx, dy);
      renderShape(shape);
      updateSelectionBox();
      return;
    }
    if (state.pointers.mode === 'framebox' && state.previewBox) {
      const task = taskById(state.previewBox.taskId);
      const image = G.screenToImage(pos.x, pos.y, state.transform);
      const norm = G.toNorm(image.x, image.y, state.imgW, state.imgH);
      state.previewBox.current = norm;
      const dx = (norm[0] - state.previewBox.start[0]) * state.imgW * state.transform.s;
      const dy = (norm[1] - state.previewBox.start[1]) * state.imgH * state.transform.s;
      if (Math.hypot(dx, dy) > 4) state.previewBox.moved = true;
      updatePreviewBox(normRect(state.previewBox.start, norm), task ? task.color : COLORS[0]);
      return;
    }
    const shape = state.shapes[state.shapes.length - 1];
    if (!shape || !shape.preview) return;
    const image = G.screenToImage(pos.x, pos.y, state.transform);
    const norm = G.toNorm(image.x, image.y, state.imgW, state.imgH);
    if (shape.type === 'pen') {
      const last = shape.points[shape.points.length - 1];
      const dx = (norm[0] - last[0]) * state.imgW * state.transform.s;
      const dy = (norm[1] - last[1]) * state.imgH * state.transform.s;
      if (Math.hypot(dx, dy) < 1.5) return;
      shape.points.push(norm);
      state.elements.get(shape.id)?.setAttribute('d', G.pathFromPoints(imagePoints(shape)));
    } else {
      shape.points[1] = norm;
      renderShape(shape);
    }
  }

  function onMapPointerUp() {
    if (!state.pointers.mode) return;
    const mode = state.pointers.mode;
    const pointerState = state.pointers;
    state.pointers = { mode: null, lastX: 0, lastY: 0 };
    document.body.classList.remove('is-panning', 'is-drawing');
    if (mode === 'framebox') {
      const preview = state.previewBox;
      state.previewBox = null;
      el.taskLayer.querySelector('.task-frame.preview')?.remove();
      const task = taskById(preview && preview.taskId);
      if (!preview || !task) return;
      const end = preview.current || preview.start;
      const screenW = Math.abs(end[0] - preview.start[0]) * state.imgW * state.transform.s;
      const screenH = Math.abs(end[1] - preview.start[1]) * state.imgH * state.transform.s;
      if (!preview.moved || screenW < 8 || screenH < 8) {
        const hit = taskBoxAt(task, preview.start);
        if (hit) {
          removeTaskBox(task, hit.id);
          showToast(`已删除「${task.name}」的一个框`);
        }
        return;
      }
      addTaskBox(task, normRect(preview.start, end));
      showToast(`已加入「${task.name}」：共 ${task.boxes.length} 处`);
      return;
    }
    if (mode === 'pan') {
      if (pointerState.boxHit && !pointerState.moved) {
        const task = taskById(pointerState.boxHit.taskId);
        if (task) toggleBoxDone(task, pointerState.boxHit.boxId);
      }
      return;
    }
    if (mode === 'move-shape') {
      const before = state.pendingBefore;
      state.pendingBefore = null;
      document.body.classList.remove('is-moving-shape');
      if (before) {
        commitChange(before);
        persistNow();
      }
      return;
    }
    if (mode !== 'draw') return;
    const shape = state.shapes[state.shapes.length - 1];
    const before = state.pendingBefore;
    state.pendingBefore = null;
    if (!shape || !shape.preview) return;
    delete shape.preview;
    if (screenDistance(shape) < 6) {
      state.shapes = before || state.shapes.filter((item) => item.id !== shape.id);
      renderShapes();
      return;
    }
    commitChange(before || []);
    persistNow();
  }

  /* ---------------- 视图切换 ---------------- */

  function setTool(tool) {
    state.tool = tool;
    document.body.dataset.tool = tool;
    for (const button of el.toolGroup.querySelectorAll('.tool')) {
      button.classList.toggle('active', button.dataset.tool === tool);
    }
    el.mapHint.textContent = HINTS[tool] || '';
    if (tool !== 'select' && tool !== 'pan') setSelection(null);
  }

  function setColor(color) {
    state.color = color;
    for (const swatch of el.colorGroup.querySelectorAll('.swatch')) {
      swatch.classList.toggle('active', swatch.dataset.color === color);
    }
    const shape = selectedShape();
    if (shape && shape.color !== color) {
      const before = snapshot();
      shape.color = color;
      renderShapes();
      commitChange(before);
      persistNow();
    }
  }

  function setWidth(width) {
    state.width = width;
    for (const button of el.widthGroup.querySelectorAll('.width-btn')) {
      button.classList.toggle('active', Number(button.dataset.width) === width);
    }
    const shape = selectedShape();
    if (shape && shape.width !== width) {
      const before = snapshot();
      shape.width = width;
      renderShapes();
      commitChange(before);
      persistNow();
    }
  }

  function onFullImageLoad() {
    if (state.view !== 'map' || !el.mapFull.naturalWidth) return;
    const width = el.mapFull.naturalWidth;
    const height = el.mapFull.naturalHeight;
    const previousFit = state.fitScale;
    const relative = previousFit ? state.transform.s / previousFit : 1;
    setStageSize(width, height);
    const { w, h } = refreshScaleRange();
    state.transform = G.clampTranslation(
      { s: G.clamp(state.fitScale * relative, state.minScale, state.maxScale), tx: state.transform.tx, ty: state.transform.ty },
      width,
      height,
      w,
      h,
    );
    applyTransform();
    renderShapes();
    renderTasks();
    el.mapFull.classList.add('is-loaded');
    const regionId = state.regionId;
    setTimeout(() => {
      if (state.view === 'map' && state.regionId === regionId && el.mapFull.classList.contains('is-loaded')) {
        el.mapPreview.removeAttribute('src');
      }
    }, 320);
  }

  async function openRegion(id) {
    const region = regionById(id);
    if (!region) return;
    if (state.view === 'map' && state.regionId && state.regionId !== id) await persistNow();
    const saved = state.annotations.maps?.[id] || {};
    state.view = 'map';
    state.regionId = id;
    rememberRegion(id);
    state.shapes = deepCopy(saved.shapes || []);
    state.selectedShapeId = null;
    state.selectionEl = null;
    state.framingTaskId = null;
    state.taskFormOpen = false;
    state.previewBox = null;
    document.body.classList.remove('is-framing');
    state.history = [];
    state.future = [];
    document.body.dataset.view = 'map';
    el.overview.classList.add('hidden');
    el.mapView.classList.remove('hidden');
    el.mapTitle.textContent = region.name;
    el.mapBadge.textContent = region.badge || '';
    el.mapBadge.classList.toggle('hidden', !region.badge);
    el.mapPreview.removeAttribute('src');
    el.mapFull.classList.remove('is-loaded');
    el.mapFull.removeAttribute('src');
    renderShapes();
    renderTasks();
    updateTaskPanel();
    updateHistoryButtons();
    resetClearButton();
    setTool(state.tool);
    pokeToolbars();
    const previewUrl = assetUrl(region.preview);
    try {
      const meta = await getImageMeta(previewUrl);
      setStageSize(meta.w, meta.h);
      fitView();
    } catch (error) {
      showToast(error.message);
    }
    if (state.view !== 'map' || state.regionId !== id) return;
    el.mapPreview.src = previewUrl;
    el.mapFull.src = regionSourceUrl(region);
  }

  async function goOverview() {
    if (state.view === 'overview') return;
    await persistNow();
    state.framingTaskId = null;
    state.taskFormOpen = false;
    state.previewBox = null;
    document.body.classList.remove('is-framing');
    state.view = 'overview';
    state.regionId = null;
    rememberOverview();
    state.shapes = [];
    state.history = [];
    state.future = [];
    document.body.dataset.view = 'overview';
    el.mapView.classList.add('hidden');
    el.overview.classList.remove('hidden');
    el.mapPreview.removeAttribute('src');
    el.mapFull.removeAttribute('src');
    el.mapFull.classList.remove('is-loaded');
    el.shapeLayer.textContent = '';
    el.taskLayer.textContent = '';
    state.elements.clear();
    state.taskElements.clear();
    fitOverview();
    pokeToolbars();
  }

  /* ---------------- 事件绑定 ---------------- */

  function buildColorWidthButtons() {
    el.colorGroup.textContent = '';
    for (const color of COLORS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset.color = color;
      button.style.background = color;
      button.title = `颜色 ${color}`;
      button.addEventListener('click', () => setColor(color));
      el.colorGroup.append(button);
    }
    el.widthGroup.textContent = '';
    for (const width of WIDTHS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn width-btn';
      button.dataset.width = String(width);
      button.title = `线条粗细 ${width}px`;
      const bar = document.createElement('i');
      bar.style.width = `${width * 2 + 6}px`;
      bar.style.height = `${width}px`;
      button.append(bar);
      button.addEventListener('click', () => setWidth(width));
      el.widthGroup.append(button);
    }
    setColor(state.color);
    setWidth(state.width);
  }

  function bindEvents() {
    el.creditAuthor.addEventListener('click', (event) => {
      // 交给系统浏览器打开，不在应用里开新窗口
      event.preventDefault();
      api.openExternal(el.creditAuthor.href).catch((error) => showToast(`打不开链接：${error.message}`));
    });
    el.btnCalibrate.addEventListener('click', () => setCalibration(!state.calibration));
    el.btnCloseCalibration.addEventListener('click', () => setCalibration(false));
    el.btnResetHotspots.addEventListener('click', resetHotspots);
    el.overviewViewport.addEventListener('pointermove', onOverviewPointerMove);
    el.overviewViewport.addEventListener('pointerup', onOverviewPointerUp);
    el.overviewViewport.addEventListener('pointercancel', onOverviewPointerUp);
    el.overviewViewport.addEventListener('pointerdown', onOverviewPointerDown);
    el.overviewViewport.addEventListener('dblclick', fitOverview);
    el.overviewViewport.addEventListener(
      'wheel',
      (event) => {
        if (state.view !== 'overview') return;
        event.preventDefault();
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        zoomOverviewAt(Math.exp(-delta * 0.0016), event.clientX, event.clientY);
      },
      { passive: false },
    );
    el.btnBack.addEventListener('click', goOverview);
    for (const button of el.toolGroup.querySelectorAll('.tool')) {
      button.addEventListener('click', () => setTool(button.dataset.tool));
    }
    el.btnUndo.addEventListener('click', undo);
    el.btnRedo.addEventListener('click', redo);
    el.btnDeleteShape.addEventListener('click', deleteSelectedShape);
    el.btnShapeVisible.addEventListener('click', toggleShapeLayer);
    el.btnClear.addEventListener('click', clearShapes);
    el.btnZoomIn.addEventListener('click', () => zoomBy(1.35));
    el.btnZoomOut.addEventListener('click', () => zoomBy(1 / 1.35));
    el.btnZoom100.addEventListener('click', () => zoomToScale(1));
    el.btnFit.addEventListener('click', fitView);
    el.btnFullscreen.addEventListener('click', () => api.toggleFullscreen());
    el.btnTaskAdd.addEventListener('click', () => {
      if (state.framingTaskId) stopFraming();
      else openTaskForm(!state.taskFormOpen);
    });
    el.btnTaskLabels.addEventListener('click', toggleAllTaskLabels);
    el.taskForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = el.taskName.value;
      const note = el.taskNote.value;
      const mode = state.taskFormMode;
      const editingId = state.editingTaskId;
      openTaskForm(false);
      if (mode === 'edit' && editingId) updateTask(editingId, { name, note, color: state.taskFormColor });
      else createTask(name, state.taskFormColor, note);
    });
    el.btnTaskCancel.addEventListener('click', () => openTaskForm(false));
    el.btnTaskUndo.addEventListener('click', undoFraming);
    el.btnScav.addEventListener('click', openScav);
    el.btnScavAgain.addEventListener('click', () => rollScav());
    el.btnScavClose.addEventListener('click', closeScav);
    el.btnDance.addEventListener('click', openDance);
    el.btnDanceClose.addEventListener('click', closeDance);
    el.btnDanceReplay.addEventListener('click', playDance);
    el.btnCopyOverview.addEventListener('click', copyView);
    el.btnCopyView.addEventListener('click', copyView);
    el.btnRecentToggle.addEventListener('click', toggleRestoreLast);
    el.danceGif.addEventListener('error', () => {
      if (dance.open && el.danceGif.getAttribute('src')) {
        const name = state.config.extras ? state.config.extras.danceGif : 'GIF';
        showToast(`没找到 ${name}，把它放到「尼沙皇吊图」文件夹里即可`);
      }
    });
    el.danceModal.addEventListener('click', (event) => {
      if (event.target === el.danceModal) closeDance();
    });
    el.btnUiToggle.addEventListener('click', () => toggleRightPanel());
    el.scavModal.addEventListener('click', (event) => {
      if (event.target === el.scavModal) closeScav();
    });
    el.mapViewport.addEventListener('pointerdown', onMapPointerDown);
    el.mapViewport.addEventListener('pointermove', onMapPointerMove);
    el.mapViewport.addEventListener('pointerup', onMapPointerUp);
    el.mapViewport.addEventListener('pointercancel', onMapPointerUp);
    el.mapViewport.addEventListener('dblclick', fitView);
    el.mapViewport.addEventListener(
      'wheel',
      (event) => {
        if (state.view !== 'map' || !state.imgW) return;
        event.preventDefault();
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        const pos = viewportPoint(event);
        zoomBy(Math.exp(-delta * 0.0016), pos.x, pos.y);
      },
      { passive: false },
    );
    el.mapFull.addEventListener('load', onFullImageLoad);
    el.mapFull.addEventListener('error', () => {
      if (state.view === 'map' && el.mapFull.getAttribute('src')) showToast('原图加载失败，正在显示预览图');
    });
    window.addEventListener('pointermove', pokeToolbars);
    window.addEventListener('pointerdown', pokeToolbars);
    window.addEventListener('beforeunload', () => {
      persistNow();
    });
    document.addEventListener('contextmenu', (event) => event.preventDefault());
    const observer = new ResizeObserver(() => {
      if (state.view === 'overview') fitOverview();
      else refitMap();
    });
    observer.observe(el.overviewViewport);
    observer.observe(el.mapViewport);
    window.addEventListener('keydown', (event) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(event.target.tagName);
      if (typing) {
        if (event.key === 'Escape') {
          event.target.blur();
          openTaskForm(false);
        }
        return;
      }
      if (event.code === 'Space' && state.view === 'map') {
        state.spacePan = true;
        document.body.classList.add('is-panning');
        event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        if (scav.open) closeScav();
        else if (dance.open) closeDance();
        else if (state.calibration) setCalibration(false);
        else if (state.framingTaskId) stopFraming();
        else if (state.selectedShapeId) setSelection(null);
        else if (state.view === 'map') goOverview();
        return;
      }
      if (event.key === 'Enter' && state.framingTaskId) {
        stopFraming();
        return;
      }
      if (event.key === 'F11') {
        api.toggleFullscreen();
        event.preventDefault();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.view === 'map' && state.selectedShapeId) {
        event.preventDefault();
        deleteSelectedShape();
        return;
      }
      if (!ctrl && event.key.toLowerCase() === 'h') {
        toggleRightPanel();
        return;
      }
      if (state.view !== 'map') return;
      if (ctrl && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else if (state.framingTaskId && state.framingHistory.length) undoFraming();
        else undo();
        return;
      }
      if (ctrl && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (ctrl && event.key === '0') {
        event.preventDefault();
        fitView();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        zoomBy(1.35);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        zoomBy(1 / 1.35);
        return;
      }
      const shortcut = { v: 'pan', s: 'select', c: 'ellipse', r: 'rect', a: 'arrow', p: 'pen' }[event.key.toLowerCase()];
      if (shortcut && !ctrl) setTool(shortcut);
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        state.spacePan = false;
        if (!state.pointers.mode) document.body.classList.remove('is-panning');
      }
    });
  }

  /* ---------------- 调试与自检接口 ---------------- */

  function waitImage(img, timeout = 25000) {
    return new Promise((resolve) => {
      if (img.naturalWidth) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), timeout);
      img.addEventListener(
        'load',
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
      img.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          resolve(false);
        },
        { once: true },
      );
    });
  }

  async function runSelfCheck() {
    const results = [];
    const record = (name, pass, detail) =>
      results.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });

    const hotspotNodes = el.overviewSvg.querySelectorAll('.hotspot');
    record('大地图热点数量为 13', hotspotNodes.length === 13, hotspotNodes.length);
    const loadingDeadline = Date.now() + 8000;
    while (Date.now() < loadingDeadline && !el.loading.classList.contains('done')) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    record(
      '启动加载页有进度条且就绪后自动收起',
      Boolean(el.loading) &&
        el.loadingFill.style.width === '100%' &&
        el.loading.classList.contains('done') &&
        el.loadingGif.naturalWidth > 0,
      `进度 ${el.loadingFill.style.width} · ${el.loadingText.textContent} · GIF ${el.loadingGif.naturalWidth}x${el.loadingGif.naturalHeight}`,
    );
    record(
      '大地图已按截图取景裁剪',
      state.overviewMeta.w === 1220 && state.overviewMeta.h === 866 && el.overviewImg.naturalWidth === 2440,
      `${state.overviewMeta.w}x${state.overviewMeta.h} / 显示 ${el.overviewImg.naturalWidth}x${el.overviewImg.naturalHeight}`,
    );
    record(
      '主界面没有多余装饰文字',
      !document.querySelector('.brand') && !document.getElementById('overview-status'),
      '',
    );

    const frames = Array.from(el.overviewSvg.querySelectorAll('.hotspot')).map((node) => ({
      id: node.dataset.id,
      w: Number(node.querySelector('.frame').getAttribute('width')),
      h: Number(node.querySelector('.frame').getAttribute('height')),
    }));
    record(
      '热区是覆盖地区文字的方形区域',
      frames.length === 13 && frames.every((item) => item.w >= 70 && item.h >= 36),
      frames.map((item) => `${item.id}:${item.w}x${item.h}`).join(' '),
    );

    const probe = el.overviewSvg.querySelector('.hotspot');
    const probeFrame = probe.querySelector('.frame');
    const idleFill = getComputedStyle(probeFrame).fill;
    const idleCursor = getComputedStyle(probe).cursor;
    probe.classList.add('is-hover');
    await new Promise((resolve) => setTimeout(resolve, 220));
    const hoverFill = getComputedStyle(probeFrame).fill;
    const hoverStroke = getComputedStyle(probeFrame).stroke;
    probe.classList.remove('is-hover');
    record(
      '鼠标移到热区上高亮显示',
      idleFill !== hoverFill && !/,\s*0\)$/.test(hoverFill) && !/,\s*0\)$/.test(hoverStroke) && idleCursor === 'pointer',
      `${idleFill} → ${hoverFill}`,
    );

    const iceRegion = regionById('icebreaker');
    const beforeMoveX = Number(state.hotspots.get('icebreaker').frame.getAttribute('x'));
    iceRegion.hotspot = [iceRegion.hotspot[0] + 0.05, iceRegion.hotspot[1]];
    positionHotspot(iceRegion);
    const afterMoveX = Number(state.hotspots.get('icebreaker').frame.getAttribute('x'));
    iceRegion.hotspot = [iceRegion.hotspot[0] - 0.05, iceRegion.hotspot[1]];
    positionHotspot(iceRegion);
    record(
      '热区矩形随位置一起移动',
      Math.abs(afterMoveX - beforeMoveX - 0.05 * state.overviewMeta.w) < 0.5,
      `${beforeMoveX.toFixed(1)} → ${afterMoveX.toFixed(1)}`,
    );

    const ovRect = el.overviewViewport.getBoundingClientRect();
    const fittedScale = overview.s;
    zoomOverviewAt(2.5, ovRect.left + ovRect.width / 2, ovRect.top + ovRect.height / 2);
    const zoomedScale = overview.s;
    const pannedBefore = overview.tx;
    overviewPointer.active = true;
    overviewPointer.moved = true;
    overviewPointer.lastX = ovRect.left + 500;
    overviewPointer.lastY = ovRect.top + 400;
    onOverviewPointerMove({ clientX: ovRect.left + 400, clientY: ovRect.top + 320 });
    const pannedAfter = overview.tx;
    overviewPointer.active = false;
    zoomOverviewAt(100, ovRect.left + 10, ovRect.top + 10);
    const maxScale = overview.s;
    fitOverview();
    record(
      '大地图可以缩放、拖动，也能一键适应窗口',
      zoomedScale > fittedScale * 2 &&
        Math.abs(pannedAfter - pannedBefore) > 10 &&
        Math.abs(maxScale - overview.max) < 1e-6 &&
        Math.abs(overview.s - overview.fit) < 1e-6,
      `${fittedScale.toFixed(2)} → ${zoomedScale.toFixed(2)}，平移 ${(pannedAfter - pannedBefore).toFixed(0)}px，上限 ${maxScale.toFixed(2)}`,
    );

    record(
      '主界面左下角有 scav 宝箱入口且弹窗默认关闭',
      Boolean(el.btnScav) && el.scavModal.classList.contains('hidden'),
      el.btnScav ? el.btnScav.textContent.trim().replace(/\s+/g, '') : '缺少按钮',
    );
    record(
      '最近浏览与复制视图的入口都在',
      Boolean(el.recentBar) && Boolean(el.btnRecentToggle) && Boolean(el.btnCopyOverview) && Boolean(el.btnCopyView),
      el.btnRecentToggle.title,
    );

    const overviewActions = document.getElementById('overview-actions');
    record(
      '右上角有面板显隐开关且默认展开',
      Boolean(el.btnUiToggle) &&
        !document.body.classList.contains('ui-right-hidden') &&
        el.btnUiToggle.offsetParent !== null &&
        overviewActions.offsetParent !== null,
      el.btnUiToggle ? el.btnUiToggle.title : '缺少按钮',
    );
    toggleRightPanel(true);
    record(
      '一键收起右上角 UI，开关自己留着',
      document.body.classList.contains('ui-right-hidden') &&
        overviewActions.offsetParent === null &&
        el.btnUiToggle.offsetParent !== null,
      el.btnUiToggle.title,
    );
    record(
      '收起状态会被记住',
      (await api.loadSettings()).rightPanelHidden === true,
      'settings.json',
    );
    toggleRightPanel(false);
    record(
      '再点一次就调回来',
      !document.body.classList.contains('ui-right-hidden') && overviewActions.offsetParent !== null,
      '',
    );

    openScav();
    const firstHaul = scav.last;
    const haulSum = firstHaul.picks.reduce((sum, pick) => sum + pick.total, 0);
    record(
      '点开宝箱直接开出一批物资',
      scav.open &&
        !el.scavModal.classList.contains('hidden') &&
        firstHaul.rolls >= 3 &&
        firstHaul.rolls <= 9 &&
        firstHaul.picks.length >= 1 &&
        el.scavLoot.children.length === firstHaul.picks.length,
      `抽 ${firstHaul.rolls} 件，同名合并后 ${firstHaul.picks.length} 行`,
    );
    record(
      '物资清单小计与总价值一致',
      haulSum === firstHaul.total && el.scavTotal.textContent === formatRubles(firstHaul.total),
      `${formatRubles(firstHaul.total)}`,
    );
    record('按钮就是「再来95000卢布的」', el.btnScavAgain.textContent === '再来95000卢布的', el.btnScavAgain.textContent);
    const rollBefore = scav.rollNo;
    rollScav();
    record(
      '点按钮可以重新抽一次',
      scav.rollNo === rollBefore + 1 && el.scavLoot.children.length === scav.last.picks.length,
      `第 ${scav.rollNo} 次`,
    );
    let simMin = Infinity;
    let simMax = 0;
    let simSum = 0;
    let simEmpty = 0;
    const simCount = 3000;
    for (let i = 0; i < simCount; i += 1) {
      const result = window.NJTScav.roll(state.config.scav);
      simMin = Math.min(simMin, result.total);
      simMax = Math.max(simMax, result.total);
      simSum += result.total;
      if (!result.picks.length) simEmpty += 1;
    }
    record(
      '开箱结果始终有物资且价值合理',
      simEmpty === 0 && simMin > 0 && simMax < 5000000 && simSum / simCount > 60000,
      `模拟 ${simCount} 次：均 ${Math.round(simSum / simCount)} / 低 ${simMin} / 高 ${simMax}`,
    );
    closeScav();
    record('可以关掉宝箱界面', !scav.open && el.scavModal.classList.contains('hidden'), '');

    record(
      '左下角有尼沙皇跳舞按钮且弹窗默认关闭',
      Boolean(el.btnDance) && !el.btnDance.classList.contains('hidden') && el.danceModal.classList.contains('hidden'),
      el.btnDance ? el.btnDance.textContent.trim().replace(/\s+/g, '') : '缺少按钮',
    );
    const gifResponse = await fetch(danceSourceUrl());
    const gifBuffer = await gifResponse.arrayBuffer();
    const gifHead = new Uint8Array(gifBuffer.slice(0, 12));
    const gifTag = String.fromCharCode(gifHead[0], gifHead[1], gifHead[2]);
    const gifRiff = String.fromCharCode(gifHead[0], gifHead[1], gifHead[2], gifHead[3]);
    const gifWebp = String.fromCharCode(gifHead[8], gifHead[9], gifHead[10], gifHead[11]);
    record(
      '跳舞动图能被读取',
      gifResponse.ok && (gifTag === 'GIF' || (gifRiff === 'RIFF' && gifWebp === 'WEBP')) && gifBuffer.byteLength > 10000,
      `${gifResponse.status} / ${Math.round(gifBuffer.byteLength / 1024)} KB / ${gifTag === 'GIF' ? 'GIF' : 'WebP'}`,
    );
    openDance();
    const gifReady = await waitImage(el.danceGif, 15000);
    record(
      '点按钮就开始播放',
      dance.open && gifReady && el.danceGif.naturalWidth > 0 && !el.danceModal.classList.contains('hidden'),
      `${el.danceGif.naturalWidth}x${el.danceGif.naturalHeight}`,
    );
    const firstDanceSrc = el.danceGif.getAttribute('src');
    playDance();
    record('可以重播一遍', el.danceGif.getAttribute('src') !== firstDanceSrc, '');
    closeDance();
    record(
      '可以关掉跳舞界面',
      !dance.open && el.danceModal.classList.contains('hidden') && !el.danceGif.getAttribute('src'),
      '',
    );

    const sampleRegion = regionById('icebreaker');
    const sampleResponse = await fetch(regionSourceUrl(sampleRegion));
    const sampleBuffer = await sampleResponse.arrayBuffer();
    const sampleHead = new Uint8Array(sampleBuffer.slice(0, 12));
    const sampleRiff = String.fromCharCode(sampleHead[0], sampleHead[1], sampleHead[2], sampleHead[3]);
    const sampleWebp = String.fromCharCode(sampleHead[8], sampleHead[9], sampleHead[10], sampleHead[11]);
    record(
      '图片协议按原字节读出显示副本（破冰船为 WebP）',
      sampleResponse.ok && sampleRiff === 'RIFF' && sampleWebp === 'WEBP' && sampleBuffer.byteLength > 100000,
      `${sampleResponse.status} / ${Math.round(sampleBuffer.byteLength / 1024)} KB`,
    );

    for (const region of state.config.regions) {
      await openRegion(region.id);
      const meta = await getImageMeta(assetUrl(region.preview)).catch(() => null);
      const src = el.mapPreview.getAttribute('src') || '';
      const previewOk = Boolean(meta) && src.endsWith(encodeURIComponent(region.preview.split('/').pop()));
      const titleOk = el.mapTitle.textContent === region.name;
      record(
        `进入 ${region.name}`,
        titleOk && previewOk,
        `${el.mapTitle.textContent} / ${meta ? `${meta.w}x${meta.h}` : '预览失败'}`,
      );
    }

    const missingDisplay = [];
    for (const region of state.config.regions) {
      if (!region.display) {
        missingDisplay.push(`${region.id}:无副本`);
        continue;
      }
      const response = await fetch(regionSourceUrl(region)).catch(() => null);
      if (!response || !response.ok) missingDisplay.push(region.id);
    }
    record(
      '每张地图都有打包好的显示副本',
      missingDisplay.length === 0,
      missingDisplay.length ? missingDisplay.join('、') : '13 张副本可读，原图目录不需要进包',
    );

    await openRegion('interchange');
    const largeOk = await waitImage(el.mapFull, 30000);
    record(
      '立交桥原图加载完成并替换预览',
      largeOk && el.mapFull.naturalWidth === 9600 && el.mapFull.classList.contains('is-loaded'),
      `${el.mapFull.naturalWidth}x${el.mapFull.naturalHeight}`,
    );

    await openRegion('customs');
    await waitImage(el.mapFull, 20000);
    const sideColumnWasVisible = el.sideColumn.offsetParent !== null;
    toggleRightPanel(true);
    const sideColumnHidden = el.sideColumn.offsetParent === null;
    toggleRightPanel(false);
    record(
      '地区地图里的右侧工具栏同样受开关控制',
      sideColumnWasVisible && sideColumnHidden && el.sideColumn.offsetParent !== null,
      `可见 → 收起 → 可见`,
    );
    fitView();
    const fitted = state.transform.s;
    record('适合窗口等于最小缩放', Math.abs(fitted - state.minScale) < 1e-6, fitted);
    zoomBy(100, 300, 300);
    record('放大存在上限', Math.abs(state.transform.s - state.maxScale) < 1e-6, state.transform.s);
    zoomBy(0.0001, 300, 300);
    record('缩小存在下限（适应窗口）', Math.abs(state.transform.s - state.minScale) < 1e-9, state.transform.s);

    fitView();
    const beforeAnchor = G.screenToImage(500, 400, state.transform);
    zoomBy(2.2, 500, 400);
    const afterAnchor = G.screenToImage(500, 400, state.transform);
    record(
      '缩放锚点跟随光标',
      Math.abs(beforeAnchor.x - afterAnchor.x) < 0.5 && Math.abs(beforeAnchor.y - afterAnchor.y) < 0.5,
      `${beforeAnchor.x.toFixed(2)} vs ${afterAnchor.x.toFixed(2)}`,
    );
    fitView();

    state.shapes = [];
    renderShapes();
    const rect = addShape(shapeFromTool('rect', [0.2, 0.2], [0.45, 0.4]));
    const ellipse = addShape(shapeFromTool('ellipse', [0.5, 0.2], [0.7, 0.4]));
    const arrow = addShape(shapeFromTool('arrow', [0.2, 0.6], [0.5, 0.8]));
    const pen = addShape(shapeFromTool('pen', [0.6, 0.6], [0.62, 0.62]));
    pen.points.push([0.66, 0.66], [0.7, 0.6]);
    renderShapes();
    record(
      '四种标注都能创建',
      [rect, ellipse, arrow, pen].every((shape) => state.elements.has(shape.id)),
      state.shapes.length,
    );

    const widthAt = (shape) => Number(state.elements.get(shape.id)?.getAttribute('stroke-width') || 0);
    const screenWidthAtFit = widthAt(rect) * state.transform.s;
    zoomBy(3, 500, 400);
    const screenWidthZoomed = widthAt(rect) * state.transform.s;
    record(
      '描边粗细在缩放下保持屏幕恒定',
      Math.abs(screenWidthAtFit - state.width) < 0.01 && Math.abs(screenWidthZoomed - state.width) < 0.01,
      `${screenWidthAtFit.toFixed(2)} / ${screenWidthZoomed.toFixed(2)}`,
    );

    setColor(COLORS[2]);
    setWidth(WIDTHS[2]);
    const styled = addShape(shapeFromTool('ellipse', [0.3, 0.3], [0.4, 0.4]));
    record('颜色与线宽生效', styled.color === COLORS[2] && styled.width === WIDTHS[2], `${styled.color} ${styled.width}`);

    const countBeforeUndo = state.shapes.length;
    undo();
    const afterUndo = state.shapes.length;
    redo();
    record(
      '撤销与重做',
      afterUndo === countBeforeUndo - 1 && state.shapes.length === countBeforeUndo,
      `${countBeforeUndo} → ${afterUndo} → ${state.shapes.length}`,
    );

    const targetShape = state.shapes[0];
    const hitShape = hitTestShape({ x: 0.2 * state.imgW, y: 0.3 * state.imgH });
    record('可以点选单条标注', hitShape === targetShape, hitShape ? hitShape.type : '未命中');
    setSelection(targetShape.id);
    record(
      '选中后出现虚线框且删除键可用',
      Boolean(state.selectionEl) && !el.btnDeleteShape.disabled,
      state.selectionEl ? '已显示选择框' : '没有选择框',
    );
    const beforePoints = targetShape.points.map((point) => point.slice());
    G.translateShape(targetShape, 0.05, 0.04);
    renderShape(targetShape);
    record(
      '选中的标注可以被拖动',
      targetShape.points[0][0] - beforePoints[0][0] > 0.049 && targetShape.points[0][1] - beforePoints[0][1] > 0.039,
      `${beforePoints[0]} → ${targetShape.points[0]}`,
    );
    setColor(COLORS[3]);
    record('选中状态下换色只改这一条', targetShape.color === COLORS[3], targetShape.color);
    const countBeforeDelete = state.shapes.length;
    deleteSelectedShape();
    record(
      '可以删除单条标注',
      state.shapes.length === countBeforeDelete - 1 && !state.selectedShapeId,
      `${countBeforeDelete} → ${state.shapes.length}`,
    );
    toggleShapeLayer();
    const layerHidden = el.shapeLayer.classList.contains('is-hidden');
    toggleShapeLayer();
    record(
      '标注层可以整体隐藏而不丢数据',
      layerHidden && !el.shapeLayer.classList.contains('is-hidden') && state.shapes.length > 0,
      `剩余 ${state.shapes.length} 条`,
    );

    await persistNow();
    const reloaded = await api.loadAnnotations();
    const saved = reloaded?.maps?.customs?.shapes || [];
    record('标注按地图写入本机文件', saved.length === state.shapes.length, `customs=${saved.length} 内存=${state.shapes.length}`);
    record('其它地图未被写入标注', !reloaded?.maps?.forest, Object.keys(reloaded?.maps || {}).join(','));

    state.tasks = [];
    state.framingTaskId = null;
    renderTasks();
    updateTaskPanel();
    record(
      '没有任务时面板只显示一个加号',
      el.taskList.children.length === 0 &&
        el.taskPanel.classList.contains('is-empty') &&
        !el.btnTaskAdd.classList.contains('hidden') &&
        el.btnTaskAdd.textContent === '＋',
      el.btnTaskAdd.textContent,
    );

    openTaskForm(true);
    const formVisible = !el.taskForm.classList.contains('hidden');
    el.taskName.value = '测试任务';
    state.taskFormColor = TASK_COLORS[2];
    openTaskForm(false);
    const task = createTask('测试任务', TASK_COLORS[2], '东楼102');
    record(
      '加号可以给任务起名选色并开始框选',
      formVisible &&
        Boolean(task) &&
        state.framingTaskId === task.id &&
        task.color === TASK_COLORS[2] &&
        task.name === '测试任务' &&
        task.note === '东楼102',
      `${task && task.name} / ${task && task.color} / ${task && task.note}`,
    );

    addTaskBox(task, [0.2, 0.2, 0.15, 0.12]);
    addTaskBox(task, [0.4, 0.3, 0.2, 0.15]);
    record(
      '一个任务可以框出多个地点',
      task.boxes.length === 2 && el.taskLayer.querySelectorAll('.task-box').length === 2,
      `${task.boxes.length} 个框 / ${el.taskLayer.querySelectorAll('.task-box').length} 个元素`,
    );
    record(
      '地点旁的任务名带着备注',
      el.taskLayer.querySelector('.task-label text')?.textContent === '测试任务（东楼102）',
      el.taskLayer.querySelector('.task-label text')?.textContent,
    );

    undoFraming();
    const afterFirstUndo = task.boxes.length;
    undoFraming();
    const afterSecondUndo = task.boxes.length;
    const undoDisabled = el.btnTaskUndo.disabled;
    addTaskBox(task, [0.2, 0.2, 0.15, 0.12]);
    addTaskBox(task, [0.4, 0.3, 0.2, 0.15]);
    record(
      '框选过程中可以撤销刚框错的地方',
      afterFirstUndo === 1 && afterSecondUndo === 0 && undoDisabled && task.boxes.length === 2,
      `${afterFirstUndo} → ${afterSecondUndo}（撤销按钮禁用：${undoDisabled}）`,
    );

    updateTask(task.id, { note: '东楼103' });
    record(
      '任务备注可以改',
      el.taskLayer.querySelector('.task-label text')?.textContent === '测试任务（东楼103）' &&
        el.taskList.querySelector('.task-note')?.textContent === '（东楼103）',
      el.taskList.querySelector('.task-note')?.textContent,
    );

    record(
      '框出的地点旁显示任务名',
      el.taskLayer.querySelectorAll('.task-label').length === 2,
      el.taskLayer.querySelectorAll('.task-label').length,
    );

    const doneBox = task.boxes[0];
    toggleBoxDone(task, doneBox.id);
    const doneFrame = el.taskLayer.querySelector('.task-frame.is-done');
    const doneLabel = el.taskLayer.querySelector('.task-label text');
    const rowCount = el.taskList.querySelector('.task-count');
    record(
      '任务地点可以勾选完成，框变灰、名称打勾',
      doneBox.done === true && Boolean(doneFrame) && doneLabel.textContent.startsWith('✓') && rowCount.textContent.includes('1/2'),
      `${doneLabel.textContent} / 进度 ${rowCount.textContent}`,
    );
    toggleBoxDone(task, doneBox.id);
    record(
      '再点一次取消完成',
      doneBox.done === false &&
        !el.taskLayer.querySelector('.task-frame.is-done') &&
        el.taskList.querySelector('.task-count').textContent === '2处',
      el.taskList.querySelector('.task-count').textContent,
    );
    toggleBoxDone(task, doneBox.id);

    const labelScreenSize = () => {
      const text = el.taskLayer.querySelector('.task-label text');
      return Number(text.getAttribute('font-size')) * state.transform.s;
    };
    zoomBy(2.5, 500, 400);
    const zoomedLabel = labelScreenSize();
    fitView();
    record(
      '任务名标签不随缩放变大变小',
      Math.abs(zoomedLabel - 13) < 0.05 && Math.abs(labelScreenSize() - 13) < 0.05,
      `${zoomedLabel.toFixed(2)}px`,
    );

    toggleTaskLabels(task.id);
    const hiddenLabels = el.taskLayer.querySelectorAll('.task-label').length;
    toggleTaskLabels(task.id);
    const shownLabels = el.taskLayer.querySelectorAll('.task-label').length;
    record('任务名可以自由开和关', hiddenLabels === 0 && shownLabels === 2, `${hiddenLabels} → ${shownLabels}`);

    // 跨地图：同一个任务在两张图上都框了地点
    await openRegion('forest');
    addTaskBox(task, [0.3, 0.3, 0.1, 0.1]);
    const forestBoxes = task.boxes.filter((box) => box.regionId === 'forest').length;
    const customsBoxes = task.boxes.filter((box) => box.regionId === 'customs').length;
    record(
      '同一个任务可以跨地图框地点',
      forestBoxes === 1 && customsBoxes === 2 && el.taskLayer.querySelectorAll('.task-box').length === 1,
      `海关 ${customsBoxes} 处 / 森林 ${forestBoxes} 处`,
    );
    await goOverview();
    const badgeDots = el.overviewTaskLayer.querySelectorAll('circle').length;
    const customsLabel = state.hotspots.get('customs').label;
    record(
      '大地图标出哪些地区挂着任务',
      badgeDots >= 2 && Boolean(customsLabel) && customsLabel.textContent.includes('任务'),
      `${badgeDots} 个任务圆点 / 提示「${customsLabel ? customsLabel.textContent : ''}」`,
    );
    await openRegion('customs');
    record(
      '地区地图只画本图的框',
      el.taskLayer.querySelectorAll('.task-box').length === 2,
      `${el.taskLayer.querySelectorAll('.task-box').length} 个框`,
    );

    await persistNow();
    const savedTasks = (await api.loadAnnotations())?.tasks || [];
    record(
      '任务写入本机文件（含跨地图地点）',
      savedTasks.length === 1 &&
        savedTasks[0].boxes.length === 3 &&
        savedTasks[0].note === '东楼103' &&
        savedTasks[0].boxes.some((box) => box.regionId === 'forest'),
      savedTasks.length ? `${savedTasks[0].name}（${savedTasks[0].note}） × ${savedTasks[0].boxes.length}` : '未写入',
    );

    deleteTask(task.id);
    record(
      '删除任务后地图上的框一并消失',
      state.tasks.length === 0 && el.taskLayer.querySelectorAll('.task-box').length === 0,
      el.taskLayer.querySelectorAll('.task-box').length,
    );

    state.shapes = [];
    state.tasks = [];
    renderShapes();
    renderTasks();
    updateTaskPanel();
    await persistNow();
    await goOverview();

    return { results, ok: results.every((item) => item.pass) };
  }

  function debugApi() {
    return {
      state: () => ({
        view: state.view,
        regionId: state.regionId,
        scale: state.transform.s,
        fitScale: state.fitScale,
        minScale: state.minScale,
        maxScale: state.maxScale,
        imgW: state.imgW,
        imgH: state.imgH,
        tool: state.tool,
        color: state.color,
        width: state.width,
        shapeCount: state.shapes.length,
        history: state.history.length,
        future: state.future.length,
        calibration: state.calibration,
        fullLoaded: el.mapFull.classList.contains('is-loaded'),
      }),
      config: () => state.config,
      hotspots: () => state.config.regions.map((region) => ({ id: region.id, name: region.name, hotspot: region.hotspot.slice() })),
      annotations: () => deepCopy(state.annotations),
      openRegion,
      goOverview,
      fit: fitView,
      zoomTo: zoomToScale,
      zoomBy,
      setTool,
      setColor,
      setWidth,
      drawShape: (type, from, to) => addShape(shapeFromTool(type, from.slice(), to.slice())),
      addPen: (points) => addShape({ id: G.uid(), type: 'pen', color: state.color, width: state.width, points: points.map((pt) => pt.slice()) }),
      shapes: () => deepCopy(state.shapes),
      tasks: () => deepCopy(state.tasks),
      framingTaskId: () => state.framingTaskId,
      createTask: (name, color, note) => deepCopy(createTask(name, color, note)),
      addTaskBox: (taskId, rect) => {
        const task = taskById(taskId);
        return task ? deepCopy(addTaskBox(task, rect)) : null;
      },
      stopFraming: () => stopFraming(),
      startFraming,
      undoFraming,
      updateTask: (taskId, changes) => deepCopy(updateTask(taskId, changes)),
      toggleTaskLabels,
      deleteTask,
      taskRows: () => Array.from(el.taskList.querySelectorAll('.task-row')).map((row) => row.dataset.id),
      scav: {
        open: openScav,
        close: closeScav,
        roll: () => deepCopy(rollScav()),
        state: () => ({ open: scav.open, rollNo: scav.rollNo, best: scav.best }),
        simulate: (count = 2000) => {
          const totals = [];
          for (let i = 0; i < count; i += 1) totals.push(window.NJTScav.roll(state.config.scav).total);
          totals.sort((a, b) => a - b);
          const mean = totals.reduce((sum, value) => sum + value, 0) / count;
          return {
            count,
            mean: Math.round(mean),
            median: totals[Math.floor(count / 2)],
            p90: totals[Math.floor(count * 0.9)],
            profitRate: Number((totals.filter((value) => value > state.config.scav.cost).length / count).toFixed(3)),
          };
        },
      },
      ui: {
        hidden: () => ui.rightHidden,
        toggle: toggleRightPanel,
        set: (value) => toggleRightPanel(Boolean(value)),
      },
      prefs: () => deepCopy(prefs),
      setPrefs: (patch) => {
        Object.assign(prefs, patch);
        savePrefs();
        renderRecentBar();
        return deepCopy(prefs);
      },
      copyView,
      selected: () => state.selectedShapeId,
      selectionBox: () => Boolean(state.selectionEl),
      selectAt: (normX, normY) => {
        const hit = hitTestShape({ x: normX * state.imgW, y: normY * state.imgH });
        setSelection(hit ? hit.id : null);
        return hit ? hit.id : null;
      },
      moveSelected: (dx, dy) => {
        const shape = selectedShape();
        if (!shape) return null;
        const before = snapshot();
        G.translateShape(shape, dx, dy);
        renderShapes();
        commitChange(before);
        persistNow();
        return deepCopy(shape);
      },
      deleteSelected: deleteSelectedShape,
      shapesVisible: () => state.shapesVisible,
      toggleShapeLayer,
      toggleBoxDone: (taskId, boxId) => {
        const task = taskById(taskId);
        return task ? deepCopy(toggleBoxDone(task, boxId)) : null;
      },
      screenPoint: (normX, normY) => {
        const point = G.imageToScreen(normX * state.imgW, normY * state.imgH, state.transform);
        const rect = el.mapViewport.getBoundingClientRect();
        return { x: rect.left + point.x, y: rect.top + point.y };
      },
      dance: {
        open: openDance,
        close: closeDance,
        replay: playDance,
        isOpen: () => dance.open,
        src: () => el.danceGif.getAttribute('src'),
      },
      undo,
      redo,
      clear: () => {
        const before = deepCopy(state.shapes);
        state.shapes = [];
        renderShapes();
        commitChange(before);
        return persistNow();
      },
      save: () => persistNow(),
      calibrate: {
        enable: (on) => setCalibration(on),
        current: () => state.calibration,
        move: (id, x, y) => {
          const region = regionById(id);
          if (!region) return null;
          region.hotspot = [Number(x), Number(y)];
          positionHotspot(region);
          updateCalibrationList(region.id);
          state.overrides[id] = region.hotspot.slice();
          scheduleHotspotSave();
          return region.hotspot.slice();
        },
        reset: resetHotspots,
        listRows: () => Array.from(el.calibrationList.querySelectorAll('li')).map((li) => li.dataset.id),
      },
      hotspotScreenPoint: (id) => {
        const region = regionById(id);
        const rect = el.overviewStage.getBoundingClientRect();
        if (!region || !state.overviewMeta) return null;
        return { x: rect.left + region.hotspot[0] * rect.width, y: rect.top + region.hotspot[1] * rect.height };
      },
      selfCheck: runSelfCheck,
    };
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    el.loading = document.getElementById('loading');
    el.loadingGif = document.getElementById('loading-gif');
    el.loadingFill = document.getElementById('loading-fill');
    el.loadingText = document.getElementById('loading-text');
    el.loadingHint = document.getElementById('loading-hint');
    el.loading.addEventListener('pointerdown', requestSkipLoading);
    window.addEventListener('keydown', requestSkipLoading);
    // 先按默认文件名把 GIF 挂上，让它和配置读取并行加载
    el.loadingGif.src = assetUrl('maps/dance.webp');
    setLoading(12, '正在读取配置…');

    el.overview = document.getElementById('view-overview');
    el.overviewViewport = document.getElementById('overview-viewport');
    el.overviewStage = document.getElementById('overview-stage');
    el.overviewImg = document.getElementById('overview-img');
    el.overviewBackdrop = document.getElementById('overview-backdrop');
    el.overviewSvg = document.getElementById('overview-svg');
    el.overviewHotspotLayer = document.getElementById('overview-hotspot-layer');
    el.overviewTaskLayer = document.getElementById('overview-task-layer');
    el.btnCalibrate = document.getElementById('btn-calibrate');
    el.calibrationPanel = document.getElementById('calibration-panel');
    el.calibrationList = document.getElementById('calibration-list');
    el.btnCloseCalibration = document.getElementById('btn-close-calibration');
    el.btnResetHotspots = document.getElementById('btn-reset-hotspots');
    el.mapView = document.getElementById('view-map');
    el.mapViewport = document.getElementById('map-viewport');
    el.mapStage = document.getElementById('map-stage');
    el.mapPreview = document.getElementById('map-preview');
    el.mapFull = document.getElementById('map-full');
    el.mapSvg = document.getElementById('map-svg');
    el.shapeLayer = document.getElementById('shape-layer');
    el.taskLayer = document.getElementById('task-layer');
    el.taskPanel = document.getElementById('task-panel');
    el.taskList = document.getElementById('task-list');
    el.taskForm = document.getElementById('task-form');
    el.taskName = document.getElementById('task-name');
    el.taskNote = document.getElementById('task-note');
    el.taskColors = document.getElementById('task-colors');
    el.btnTaskAdd = document.getElementById('btn-task-add');
    el.btnTaskUndo = document.getElementById('btn-task-undo');
    el.btnTaskCreate = document.getElementById('btn-task-create');
    el.btnTaskLabels = document.getElementById('btn-task-labels');
    el.btnScav = document.getElementById('btn-scav');
    el.scavModal = document.getElementById('scav-modal');
    el.scavLoot = document.getElementById('scav-loot');
    el.scavTotal = document.getElementById('scav-total');
    el.scavProfit = document.getElementById('scav-profit');
    el.scavRollNo = document.getElementById('scav-roll-no');
    el.scavBest = document.getElementById('scav-best');
    el.scavCost = document.getElementById('scav-cost');
    el.btnScavAgain = document.getElementById('btn-scav-again');
    el.btnScavClose = document.getElementById('btn-scav-close');
    el.scavNote = document.getElementById('scav-note');
    el.btnDance = document.getElementById('btn-dance');
    el.danceModal = document.getElementById('dance-modal');
    el.danceGif = document.getElementById('dance-gif');
    el.btnDanceClose = document.getElementById('btn-dance-close');
    el.btnDanceReplay = document.getElementById('btn-dance-replay');
    el.btnCopyOverview = document.getElementById('btn-copy-overview');
    el.btnCopyView = document.getElementById('btn-copy-view');
    el.creditVersion = document.getElementById('credit-version');
    el.creditAuthor = document.getElementById('credit-author');
    el.recentBar = document.getElementById('recent-bar');
    el.recentList = document.getElementById('recent-list');
    el.btnRecentToggle = document.getElementById('btn-recent-toggle');
    el.btnTaskCancel = document.getElementById('btn-task-cancel');
    el.taskHint = document.getElementById('task-hint');
    el.mapTitle = document.getElementById('map-title');
    el.mapBadge = document.getElementById('map-badge');
    el.toolGroup = document.getElementById('tool-group');
    el.colorGroup = document.getElementById('color-group');
    el.widthGroup = document.getElementById('width-group');
    el.btnUndo = document.getElementById('btn-undo');
    el.btnRedo = document.getElementById('btn-redo');
    el.btnDeleteShape = document.getElementById('btn-delete-shape');
    el.btnShapeVisible = document.getElementById('btn-shape-visible');
    el.btnClear = document.getElementById('btn-clear');
    el.btnZoomIn = document.getElementById('btn-zoom-in');
    el.btnZoomOut = document.getElementById('btn-zoom-out');
    el.btnZoom100 = document.getElementById('btn-zoom-100');
    el.btnFit = document.getElementById('btn-fit');
    el.btnFullscreen = document.getElementById('btn-fullscreen');
    el.btnBack = document.getElementById('btn-back');
    el.zoomReadout = document.getElementById('zoom-readout');
    el.mapHint = document.getElementById('map-hint');
    el.toast = document.getElementById('toast');
    el.btnUiToggle = document.getElementById('btn-ui-toggle');
    el.sideColumn = document.getElementById('side-column');

    const loaded = await api.getConfig();
    setLoading(35, '正在准备地图数据…');
    if (loaded.version) el.creditVersion.textContent = `v${loaded.version}`;
    state.config = loaded.config;
    state.overrides = loaded.hotspots || {};
    state.annotations = (await api.loadAnnotations()) || { version: 1, maps: {} };
    const migration = migrateTasks(state.annotations);
    state.tasks = migration.tasks;
    if (migration.migrated) api.saveAnnotations(state.annotations);
    const settings = (await api.loadSettings()) || {};
    ui.rightHidden = Boolean(settings.rightPanelHidden);
    prefs.lastView = settings.lastView || null;
    prefs.recentRegions = Array.isArray(settings.recentRegions) ? settings.recentRegions : [];
    prefs.restoreLast = settings.restoreLast !== false;
    state.config.scav = loaded.scav || { version: 1, cost: 95000, items: [] };
    if (state.config.scav.source) {
      el.scavNote.textContent = `物资与价格取自 ${state.config.scav.source.replace(/^https?:\/\//, '').replace(/\/$/, '')}${
        state.config.scav.fetchedAt ? `（${state.config.scav.fetchedAt} 的跳蚤市场价快照）` : ''
      }，仅供娱乐。`;
    }
    if (!(state.config.extras && state.config.extras.danceGif)) el.btnDance.classList.add('hidden');
    const danceUrl = danceSourceUrl();
    if (!danceUrl) el.loadingGif.removeAttribute('src');
    else if (danceUrl !== assetUrl('maps/dance.webp')) el.loadingGif.src = danceUrl;
    if (!state.annotations.maps) state.annotations.maps = {};
    state.config.regions = state.config.regions.filter((region) => Array.isArray(region.hotspot) && region.hotspot.length === 2);
    for (const region of state.config.regions) {
      state.defaults[region.id] = region.hotspot.slice();
      const override = state.overrides[region.id];
      if (Array.isArray(override) && override.length === 2) region.hotspot = override.slice();
    }

    buildColorWidthButtons();
    buildTaskColorButtons();
    bindEvents();
    applyRightPanel();
    setLoading(60, '正在布置界面…');
    setTool(state.tool);
    await initOverview();
    renderRecentBar();
    const restoreRegion =
      prefs.restoreLast && prefs.lastView && prefs.lastView.type === 'map' ? regionById(prefs.lastView.regionId) : null;
    if (restoreRegion) {
      setLoading(96, '正在回到上次看的地图…');
      await openRegion(restoreRegion.id);
    }
    if (state.view === 'overview') document.body.dataset.view = 'overview';
    updateHistoryButtons();
    updateTaskPanel();
    pokeToolbars();
    window.__njt = debugApi();
    window.__njtReady = true;
    finishLoading();
  }

  window.addEventListener('DOMContentLoaded', () => {
    init().catch((error) => {
      console.error(error);
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = `启动失败：${error.message}`;
        toast.classList.remove('hidden');
      }
    });
  });
})();
