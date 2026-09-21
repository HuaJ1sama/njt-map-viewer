(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NJTGeom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function fitScale(imgW, imgH, vpW, vpH) {
    if (!imgW || !imgH || !vpW || !vpH) return 1;
    return Math.min(vpW / imgW, vpH / imgH);
  }

  /** 缩放范围：最小＝适应窗口，最大＝8 倍原始像素（图很小时取适应值）。 */
  function scaleRange(imgW, imgH, vpW, vpH) {
    const fit = fitScale(imgW, imgH, vpW, vpH);
    return { fit, min: fit, max: Math.max(8, fit) };
  }

  /** 不大于视口时居中，大于视口时不允许拖出空白。 */
  function clampTranslation(st, imgW, imgH, vpW, vpH) {
    const w = imgW * st.s;
    const h = imgH * st.s;
    const tx = w <= vpW ? (vpW - w) / 2 : clamp(st.tx, vpW - w, 0);
    const ty = h <= vpH ? (vpH - h) / 2 : clamp(st.ty, vpH - h, 0);
    return { s: st.s, tx, ty };
  }

  function fitTransform(imgW, imgH, vpW, vpH) {
    const s = fitScale(imgW, imgH, vpW, vpH);
    return { s, tx: (vpW - imgW * s) / 2, ty: (vpH - imgH * s) / 2 };
  }

  function screenToImage(px, py, st) {
    return { x: (px - st.tx) / st.s, y: (py - st.ty) / st.s };
  }

  function imageToScreen(ix, iy, st) {
    return { x: ix * st.s + st.tx, y: iy * st.s + st.ty };
  }

  /** 以 (px,py) 为锚点缩放：该点下的图像坐标保持不动。 */
  function zoomAt(st, factor, px, py, min, max) {
    const target = clamp(st.s * factor, min, max);
    if (Math.abs(target - st.s) < 1e-9) return { s: st.s, tx: st.tx, ty: st.ty };
    const anchor = screenToImage(px, py, st);
    return { s: target, tx: px - anchor.x * target, ty: py - anchor.y * target };
  }

  function rectFromPoints(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  function ellipseFromPoints(a, b) {
    const r = rectFromPoints(a, b);
    return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2 };
  }

  function pathFromPoints(points) {
    if (!points.length) return '';
    let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let i = 1; i < points.length; i += 1) {
      d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
    }
    return d;
  }

  /** 箭头头部三角形，尺寸按屏幕像素给定，换算到图像坐标系。 */
  function arrowHead(tail, tip, screenWidth, scale) {
    const dx = tip.x - tail.x;
    const dy = tip.y - tail.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6 || !scale) return null;
    const ux = dx / len;
    const uy = dy / len;
    const headLen = Math.max(12, screenWidth * 4.5) / scale;
    const half = headLen * 0.42;
    const bx = tip.x - ux * headLen;
    const by = tip.y - uy * headLen;
    return [
      { x: tip.x, y: tip.y },
      { x: bx - uy * half, y: by + ux * half },
      { x: bx + uy * half, y: by - ux * half },
    ];
  }

  function toNorm(x, y, w, h) {
    return [Number((x / w).toFixed(5)), Number((y / h).toFixed(5))];
  }

  function toImage(pt, w, h) {
    return { x: pt[0] * w, y: pt[1] * h };
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function distToPolyline(p, points) {
    if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
    let best = Infinity;
    for (let i = 1; i < points.length; i += 1) {
      best = Math.min(best, distToSegment(p, points[i - 1], points[i]));
    }
    return best;
  }

  function distToRectOutline(p, rect) {
    const corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ];
    let best = Infinity;
    for (let i = 0; i < 4; i += 1) best = Math.min(best, distToSegment(p, corners[i], corners[(i + 1) % 4]));
    return best;
  }

  function distToEllipse(p, ellipse) {
    const rx = Math.max(ellipse.rx, 1e-6);
    const ry = Math.max(ellipse.ry, 1e-6);
    const nx = (p.x - ellipse.cx) / rx;
    const ny = (p.y - ellipse.cy) / ry;
    const norm = Math.hypot(nx, ny);
    if (norm < 1e-6) return Math.min(rx, ry);
    return Math.abs(norm - 1) * Math.min(rx, ry);
  }

  function distanceToShape(p, shape, imgW, imgH) {
    const points = shape.points.map((pt) => toImage(pt, imgW, imgH));
    if (shape.type === 'rect') return distToRectOutline(p, rectFromPoints(points[0], points[1]));
    if (shape.type === 'ellipse') return distToEllipse(p, ellipseFromPoints(points[0], points[1]));
    return distToPolyline(p, points);
  }

  function pointInShape(p, shape, imgW, imgH) {
    if (shape.type !== 'rect' && shape.type !== 'ellipse') return false;
    const points = shape.points.map((pt) => toImage(pt, imgW, imgH));
    if (shape.type === 'rect') {
      const rect = rectFromPoints(points[0], points[1]);
      return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
    }
    const ellipse = ellipseFromPoints(points[0], points[1]);
    if (ellipse.rx < 1e-6 || ellipse.ry < 1e-6) return false;
    const nx = (p.x - ellipse.cx) / ellipse.rx;
    const ny = (p.y - ellipse.cy) / ellipse.ry;
    return nx * nx + ny * ny <= 1;
  }

  function shapeBounds(shape, imgW, imgH) {
    const points = shape.points.map((pt) => toImage(pt, imgW, imgH));
    const xs = points.map((pt) => pt.x);
    const ys = points.map((pt) => pt.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  function translateShape(shape, dxNorm, dyNorm) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of shape.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const clampedX = clamp(dxNorm, -minX, 1 - maxX);
    const clampedY = clamp(dyNorm, -minY, 1 - maxY);
    shape.points = shape.points.map(([x, y]) => [Number((x + clampedX).toFixed(5)), Number((y + clampedY).toFixed(5))]);
    return shape;
  }

  let uidSeq = 0;
  function uid() {
    uidSeq += 1;
    return `s${Date.now().toString(36)}${uidSeq.toString(36)}`;
  }

  return {
    clamp,
    fitScale,
    scaleRange,
    clampTranslation,
    fitTransform,
    screenToImage,
    imageToScreen,
    zoomAt,
    rectFromPoints,
    ellipseFromPoints,
    pathFromPoints,
    arrowHead,
    toNorm,
    toImage,
    distToSegment,
    distToPolyline,
    distToRectOutline,
    distToEllipse,
    distanceToShape,
    pointInShape,
    shapeBounds,
    translateShape,
    uid,
  };
});
