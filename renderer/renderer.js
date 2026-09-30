// Asterisk renderer
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let dpr = window.devicePixelRatio || 1;

// ---- State ----
let items = [];
let view = { panX: 0, panY: 0, zoom: 1 };
let tool = 'pen';
let shapeType = 'rect';
let color = '#000000';
let size = 4;
let selectedId = null;
let theme = 'light';
let accentColor = '#0078d4';

let drawing = null;
let dragStart = null;
let resizeState = null;
let isPanning = false;
let panStart = null;
let erasing = false;
let erasedThisDrag = new Set();
let editOverlay = null;

let history = [];
let historyIndex = -1;
let historyRevs = [];
let revCounter = 0, revision = 0, savedRevision = 0;
let currentFile = null;
let strokeRaw = null;     // last few raw pointer samples (screen space): tells us where the hand really stopped
let liveFilter = null;    // real-time stabilizer for the current gesture
let modalOpen = false;

const imageCache = {};

const COLORS = ['#000000', '#ffffff', '#e81123', '#ff8c00', '#ffb900', '#107c10', '#00b294', '#0078d4', '#8661c5', '#e3008c'];
const STICKY_COLORS = ['#fff2a8', '#c8f7c5', '#cde7ff', '#ffd6e7', '#e5d4ff', '#ffe0c2'];

const THEME = {
  light: { canvasBg: '#ffffff', grid: '#e6e6e6' },
  dark: { canvasBg: '#1c1b1a', grid: '#343332' }
};

const SUN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const MAX_ICON = '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 2h6v6" fill="none" stroke="currentColor" stroke-width="1"/><rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

// ---- Helpers ----
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function screenToWorld(sx, sy) { return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom }; }
function worldToScreen(wx, wy) { return { x: wx * view.zoom + view.panX, y: wy * view.zoom + view.panY }; }
function strokeW(it) { return it.tool === 'highlighter' ? it.size * 3 : it.size; }
function pressureOf(e) { return Math.max(0.05, (e && e.pressure) || 0.5); }

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  closeEditor();
  render();
}
window.addEventListener('resize', resize);

// ---- History ----
function snapshot() { return JSON.parse(JSON.stringify(items)); }
function resetHistory() {
  history = [snapshot()];
  historyRevs = [++revCounter];
  historyIndex = 0;
  revision = historyRevs[0];
  updateHistoryButtons();
}
function commit() {
  history = history.slice(0, historyIndex + 1);
  historyRevs = historyRevs.slice(0, historyIndex + 1);
  history.push(snapshot());
  historyRevs.push(++revCounter);
  if (history.length > 100) { history.shift(); historyRevs.shift(); }
  historyIndex = history.length - 1;
  revision = historyRevs[historyIndex];
  updateHistoryButtons();
  updateDirtyUI();
}
function stepHistory(dir) {
  const next = historyIndex + dir;
  if (next < 0 || next >= history.length) return;
  historyIndex = next;
  items = JSON.parse(JSON.stringify(history[historyIndex]));
  revision = historyRevs[historyIndex];
  selectedId = null;
  loadImages();
  render();
  updateHistoryButtons();
  updateDirtyUI();
}
function undo() { stepHistory(-1); }
function redo() { stepHistory(1); }
function updateHistoryButtons() {
  document.getElementById('btn-undo').disabled = historyIndex <= 0;
  document.getElementById('btn-redo').disabled = historyIndex >= history.length - 1;
}

// ---- Stroke geometry ----
function strokeWidths(pts, baseWidth) {
  // 1-2-1 pass on pressure so width never jumps between samples
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)].p, b = p.p, c = pts[Math.min(pts.length - 1, i + 1)].p;
    const pr = (a + b * 2 + c) / 4;
    return Math.max(baseWidth * 0.15, baseWidth * pr * 2);
  });
}
function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

// ---- Rendering ----
function render() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (theme === 'dark') {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, '#232221');
    g.addColorStop(1, '#161514');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = THEME.light.canvasBg;
  }
  ctx.fillRect(0, 0, w, h);
  drawGrid();
  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);
  for (const it of items) drawItem(ctx, it);
  if (drawing) drawItem(ctx, drawing);
  ctx.restore();
  drawSelection();
}

function drawGrid() {
  let spacing = 40;
  while (spacing * view.zoom < 12) spacing *= 2;
  while (spacing * view.zoom > 80) spacing /= 2;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.clientWidth, canvas.clientHeight);
  const startX = Math.floor(tl.x / spacing) * spacing;
  const startY = Math.floor(tl.y / spacing) * spacing;
  ctx.fillStyle = THEME[theme].grid;
  for (let x = startX; x < br.x; x += spacing) {
    for (let y = startY; y < br.y; y += spacing) {
      const s = worldToScreen(x, y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawItem(c, it) {
  if (it.type === 'stroke') drawStroke(c, it);
  else if (it.type === 'shape') drawShape(c, it);
  else if (it.type === 'text') drawText(c, it);
  else if (it.type === 'sticky') drawSticky(c, it);
  else if (it.type === 'image') drawImageItem(c, it);
}

function drawStroke(c, it) {
  const baseWidth = strokeW(it);
  const pts = it.points;
  if (!pts || pts.length === 0) return;
  const isHi = it.tool === 'highlighter';
  const alpha = isHi ? 0.4 : 1;
  if (pts.length === 1) {
    c.globalAlpha = alpha;
    c.fillStyle = it.color;
    c.beginPath();
    c.arc(pts[0].x, pts[0].y, Math.max(0.5, baseWidth * pts[0].p * 2) / 2, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
    return;
  }
  c.globalAlpha = alpha;
  c.strokeStyle = it.color;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const n = pts.length;
  if (isHi || n === 2) {
    // one single path, so overlapping translucent caps never build dark blobs
    c.lineWidth = isHi ? baseWidth : Math.max(baseWidth * 0.15, baseWidth * (pts[0].p + pts[1].p));
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n - 1; i++) {
      const m = midpoint(pts[i], pts[i + 1]);
      c.quadraticCurveTo(pts[i].x, pts[i].y, i === n - 2 ? pts[n - 1].x : m.x, i === n - 2 ? pts[n - 1].y : m.y);
    }
    if (n === 2) c.lineTo(pts[1].x, pts[1].y);
    c.stroke();
    c.globalAlpha = 1;
    return;
  }
  const w = strokeWidths(pts, baseWidth);
  for (let i = 1; i < n - 1; i++) {
    const s = i === 1 ? pts[0] : midpoint(pts[i - 1], pts[i]);
    const e = i === n - 2 ? pts[n - 1] : midpoint(pts[i], pts[i + 1]);
    c.lineWidth = w[i];
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.quadraticCurveTo(pts[i].x, pts[i].y, e.x, e.y);
    c.stroke();
  }
  c.globalAlpha = 1;
}

function drawShape(c, it) {
  c.strokeStyle = it.color;
  c.lineWidth = it.size;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  if (it.shape === 'rect') {
    c.strokeRect(it.x, it.y, it.w, it.h);
  } else if (it.shape === 'ellipse') {
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    c.ellipse(cx, cy, Math.abs(it.w / 2), Math.abs(it.h / 2), 0, 0, Math.PI * 2);
    c.stroke();
  } else if (it.shape === 'line') {
    c.moveTo(it.x, it.y);
    c.lineTo(it.x2, it.y2);
    c.stroke();
  } else if (it.shape === 'arrow') {
    drawArrow(c, it);
  }
}

function drawArrow(c, it) {
  const x1 = it.x, y1 = it.y, x2 = it.x2, y2 = it.y2;
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(12, it.size * 4);
  const a = Math.PI / 6;
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(x2 - headLen * Math.cos(angle - a), y2 - headLen * Math.sin(angle - a));
  c.moveTo(x2, y2);
  c.lineTo(x2 - headLen * Math.cos(angle + a), y2 - headLen * Math.sin(angle + a));
  c.stroke();
}

function drawText(c, it) {
  if (editOverlay && editOverlay.it === it) return;
  c.fillStyle = it.color;
  c.font = it.size + "px 'Segoe UI', sans-serif";
  c.textBaseline = 'top';
  const lines = (it.text || '').split('\n');
  let y = it.y;
  for (const line of lines) {
    c.fillText(line, it.x, y);
    y += it.size * 1.3;
  }
}

function drawSticky(c, it) {
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.25)';
  c.shadowBlur = 10;
  c.shadowOffsetY = 3;
  c.fillStyle = it.color;
  roundRect(c, it.x, it.y, it.w, it.h, 6);
  c.fill();
  c.restore();
  if (editOverlay && editOverlay.it === it) return;
  c.fillStyle = '#1a1a1a';
  c.font = "16px 'Segoe UI', sans-serif";
  c.textBaseline = 'top';
  const pad = 12;
  const lines = wrapText(c, it.text, it.w - pad * 2);
  let y = it.y + pad;
  for (const line of lines) {
    c.fillText(line, it.x + pad, y);
    y += 20;
  }
}

function drawImageItem(c, it) {
  const img = imageCache[it.id];
  if (!img) return;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.3)';
  c.shadowBlur = 12;
  c.shadowOffsetY = 4;
  c.drawImage(img, it.x, it.y, it.w, it.h);
  c.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function wrapText(c, text, maxW) {
  const words = (text || '').split(/\s+/);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (c.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function drawSelection() {
  if (!selectedId) return;
  const it = items.find(i => i.id === selectedId);
  if (!it) return;
  if (editOverlay && editOverlay.it === it) return;
  const b = itemBounds(it);
  const tl = worldToScreen(b.x, b.y);
  const br = worldToScreen(b.x + b.w, b.y + b.h);
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.setLineDash([]);
  if (it.type === 'image') {
    const handles = getResizeHandles(it);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    for (const key of ['nw', 'ne', 'se', 'sw']) {
      const h = handles[key];
      ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
      ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
    }
  }
}

function itemBounds(it) {
  if (it.type === 'stroke') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of it.points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const pad = strokeW(it) / 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + strokeW(it), h: maxY - minY + strokeW(it) };
  }
  if (it.type === 'shape') {
    if (it.shape === 'line' || it.shape === 'arrow') {
      const x = Math.min(it.x, it.x2), y = Math.min(it.y, it.y2);
      return { x, y, w: Math.abs(it.x2 - it.x), h: Math.abs(it.y2 - it.y) };
    }
    return { x: it.x, y: it.y, w: it.w, h: it.h };
  }
  if (it.type === 'text') {
    ctx.font = it.size + "px 'Segoe UI', sans-serif";
    const lines = (it.text || '').split('\n');
    let maxW = 0;
    for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
    return { x: it.x, y: it.y, w: maxW, h: lines.length * it.size * 1.3 };
  }
  if (it.type === 'sticky') return { x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.type === 'image') return { x: it.x, y: it.y, w: it.w, h: it.h };
  return { x: 0, y: 0, w: 0, h: 0 };
}

// ---- Hit testing ----
function hitTest(wx, wy) {
  const threshold = 6 / view.zoom;
  for (let i = items.length - 1; i >= 0; i--) {
    if (hitItem(items[i], wx, wy, threshold)) return items[i];
  }
  return null;
}
function hitItem(it, wx, wy, threshold) {
  if (it.type === 'stroke') return distToStroke(it, wx, wy) < threshold + strokeW(it) / 2;
  if (it.type === 'shape') {
    if (it.shape === 'line' || it.shape === 'arrow')
      return distToSegment(wx, wy, it.x, it.y, it.x2, it.y2) < threshold + it.size / 2;
    if (it.shape === 'rect')
      return wx >= it.x - threshold && wx <= it.x + it.w + threshold && wy >= it.y - threshold && wy <= it.y + it.h + threshold;
    if (it.shape === 'ellipse') {
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      const rx = it.w / 2 + threshold, ry = it.h / 2 + threshold;
      return ((wx - cx) ** 2) / (rx * rx) + ((wy - cy) ** 2) / (ry * ry) <= 1;
    }
  }
  if (it.type === 'text') {
    const b = itemBounds(it);
    return wx >= b.x - threshold && wx <= b.x + b.w + threshold && wy >= b.y - threshold && wy <= b.y + b.h + threshold;
  }
  if (it.type === 'sticky')
    return wx >= it.x && wx <= it.x + it.w && wy >= it.y && wy <= it.y + it.h;
  if (it.type === 'image')
    return wx >= it.x && wx <= it.x + it.w && wy >= it.y && wy <= it.y + it.h;
  return false;
}
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function distToStroke(it, px, py) {
  if (it.points.length === 1) return Math.hypot(px - it.points[0].x, py - it.points[0].y);
  let min = Infinity;
  for (let i = 1; i < it.points.length; i++) {
    const d = distToSegment(px, py, it.points[i - 1].x, it.points[i - 1].y, it.points[i].x, it.points[i].y);
    if (d < min) min = d;
  }
  return min;
}

// ---- Resize handles ----
function getResizeHandles(it) {
  const tl = worldToScreen(it.x, it.y);
  const br = worldToScreen(it.x + it.w, it.y + it.h);
  return {
    nw: { x: tl.x, y: tl.y },
    ne: { x: br.x, y: tl.y },
    se: { x: br.x, y: br.y },
    sw: { x: tl.x, y: br.y }
  };
}
function hitResizeHandle(it, sp) {
  const handles = getResizeHandles(it);
  const r = 9;
  for (const key of ['nw', 'ne', 'se', 'sw']) {
    const h = handles[key];
    if (Math.abs(sp.x - h.x) <= r && Math.abs(sp.y - h.y) <= r) return key;
  }
  return null;
}
function getAnchor(o, handle) {
  if (handle === 'se') return { x: o.x, y: o.y };
  if (handle === 'nw') return { x: o.x + o.w, y: o.y + o.h };
  if (handle === 'ne') return { x: o.x, y: o.y + o.h };
  return { x: o.x + o.w, y: o.y };
}
function onResizeMove(wp) {
  const it = resizeState.item;
  const o = resizeState.orig;
  const anchor = getAnchor(o, resizeState.handle);
  const startDist = Math.hypot(resizeState.startW.x - anchor.x, resizeState.startW.y - anchor.y) || 1;
  const curDist = Math.hypot(wp.x - anchor.x, wp.y - anchor.y);
  const scale = Math.max(0.05, curDist / startDist);
  const newW = o.w * scale;
  const newH = o.h * scale;
  it.w = newW;
  it.h = newH;
  if (resizeState.handle === 'se') { it.x = anchor.x; it.y = anchor.y; }
  else if (resizeState.handle === 'nw') { it.x = anchor.x - newW; it.y = anchor.y - newH; }
  else if (resizeState.handle === 'ne') { it.x = anchor.x; it.y = anchor.y - newH; }
  else { it.x = anchor.x - newW; it.y = anchor.y; }
  render();
}

// ---- Pointer handling ----
function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('wheel', onWheel, { passive: false });
canvas.addEventListener('dblclick', onDblClick);
// Keep focus on the text editor when placing text/sticky: the browser's mousedown
// default action would otherwise blur the freshly-opened editor and delete the
// (still empty) item before the user can type.
document.addEventListener('mousedown', (e) => {
  if (tool !== 'text' && tool !== 'sticky') return;
  const t = e.target;
  if (t === canvas || (t.closest && t.closest('#overlay'))) e.preventDefault();
});

function onPointerDown(e) {
  const sp = getPos(e);
  const wp = screenToWorld(sp.x, sp.y);

  if (e.button === 1 || e.shiftKey) {
    canvas.setPointerCapture(e.pointerId);
    isPanning = true;
    panStart = { x: sp.x, y: sp.y, panX: view.panX, panY: view.panY };
    return;
  }

  if (tool === 'text') {
    e.preventDefault();
    const it = { id: uid(), type: 'text', x: wp.x, y: wp.y, text: '', color, size: Math.max(16, size * 4) };
    items.push(it);
    selectedId = it.id;
    setTool('select');
    render();
    openTextEditor(it, true);
    return;
  }

  if (tool === 'sticky') {
    e.preventDefault();
    const it = { id: uid(), type: 'sticky', x: wp.x - 90, y: wp.y - 90, w: 180, h: 180, color: STICKY_COLORS[0], text: '' };
    items.push(it);
    selectedId = it.id;
    setTool('select');
    render();
    openTextEditor(it, true);
    return;
  }

  canvas.setPointerCapture(e.pointerId);

  if (tool === 'select') {
    // resize handle first
    if (selectedId) {
      const sel = items.find(i => i.id === selectedId);
      if (sel && sel.type === 'image') {
        const handle = hitResizeHandle(sel, sp);
        if (handle) {
          resizeState = { item: sel, handle, orig: { x: sel.x, y: sel.y, w: sel.w, h: sel.h }, startW: wp };
          return;
        }
      }
    }
    const hit = hitTest(wp.x, wp.y);
    if (hit) {
      selectedId = hit.id;
      dragStart = { item: hit, startW: wp, orig: JSON.parse(JSON.stringify(hit)) };
    } else {
      selectedId = null;
      isPanning = true;
      panStart = { x: sp.x, y: sp.y, panX: view.panX, panY: view.panY };
    }
    render();
    return;
  }

  if (tool === 'pen' || tool === 'highlighter') {
    strokeRaw = [{ x: sp.x, y: sp.y, t: e.timeStamp }];
    liveFilter = stab.on ? makeFilter() : null;
    if (liveFilter) liveFilter.filter(sp.x, sp.y, e.timeStamp);
    drawing = { id: uid(), type: 'stroke', tool, points: [{ x: wp.x, y: wp.y, p: pressureOf(e) }], color, size };
    render();
    return;
  }

  if (tool === 'eraser') {
    erasing = true;
    erasedThisDrag = new Set();
    eraseAt(wp.x, wp.y);
    return;
  }

  if (tool === 'shape') {
    liveFilter = stab.on ? makeFilter() : null;
    strokeRaw = [{ x: sp.x, y: sp.y, t: e.timeStamp }];
    if (liveFilter) liveFilter.filter(sp.x, sp.y, e.timeStamp);
    drawing = { id: uid(), type: 'shape', shape: shapeType, sx: wp.x, sy: wp.y, x: wp.x, y: wp.y, x2: wp.x, y2: wp.y, w: 0, h: 0, color, size };
    render();
    return;
  }

}

function onPointerMove(e) {
  const sp = getPos(e);
  const wp = screenToWorld(sp.x, sp.y);

  if (isPanning) {
    view.panX = panStart.panX + (sp.x - panStart.x);
    view.panY = panStart.panY + (sp.y - panStart.y);
    render();
    return;
  }
  if (resizeState) {
    onResizeMove(wp);
    return;
  }
  if (drawing && drawing.type === 'stroke') {
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const list = evs.length ? evs : [e];
    for (const ev of list) {
      const s = getPos(ev);
      const pr = pressureOf(ev);
      strokeRaw.push({ x: s.x, y: s.y, t: ev.timeStamp });
      if (strokeRaw.length > 6) strokeRaw.shift();
      const f = liveFilter ? liveFilter.filter(s.x, s.y, ev.timeStamp) : s;
      const w = screenToWorld(f.x, f.y);
      const last = drawing.points[drawing.points.length - 1];
      if (Math.hypot(w.x - last.x, w.y - last.y) > (liveFilter ? 0.4 : 1) / view.zoom) {
        drawing.points.push({ x: w.x, y: w.y, p: pr });
      }
    }
    render();
    return;
  }
  if (drawing && drawing.type === 'shape') {
    strokeRaw.push({ x: sp.x, y: sp.y, t: e.timeStamp });
    if (strokeRaw.length > 6) strokeRaw.shift();
    const fw = liveFilter ? (() => { const f = liveFilter.filter(sp.x, sp.y, e.timeStamp); return screenToWorld(f.x, f.y); })() : wp;
    if (drawing.shape === 'line' || drawing.shape === 'arrow') {
      drawing.x = drawing.sx; drawing.y = drawing.sy;
      drawing.x2 = fw.x; drawing.y2 = fw.y;
    } else {
      drawing.x = Math.min(drawing.sx, fw.x);
      drawing.y = Math.min(drawing.sy, fw.y);
      drawing.w = Math.abs(fw.x - drawing.sx);
      drawing.h = Math.abs(fw.y - drawing.sy);
    }
    render();
    return;
  }
  if (erasing) { eraseAt(wp.x, wp.y); return; }
  if (dragStart) {
    const dx = wp.x - dragStart.startW.x;
    const dy = wp.y - dragStart.startW.y;
    moveItem(dragStart.item, dragStart.orig, dx, dy);
    render();
    return;
  }
}

function onPointerUp(e) {
  try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  if (isPanning) { isPanning = false; panStart = null; return; }

  if (resizeState) {
    commit();
    resizeState = null;
    render();
    return;
  }

  if (drawing) {
    if (liveFilter && strokeRaw && strokeRaw.length) finishStabilized(drawing);
    let valid = true;
    if (drawing.type === 'shape') {
      if (drawing.shape === 'rect' || drawing.shape === 'ellipse') {
        if (drawing.w < 2 / view.zoom && drawing.h < 2 / view.zoom) valid = false;
      } else {
        if (Math.hypot(drawing.x2 - drawing.x, drawing.y2 - drawing.y) < 2 / view.zoom) valid = false;
      }
    }
    if (valid) { items.push(drawing); commit(); }
    drawing = null;
    strokeRaw = null;
    liveFilter = null;
    render();
    return;
  }
  if (erasing) {
    erasing = false;
    if (erasedThisDrag.size > 0) commit();
    erasedThisDrag = new Set();
    return;
  }
  if (dragStart) {
    const moved = JSON.stringify(dragStart.item) !== JSON.stringify(dragStart.orig);
    if (moved) commit();
    dragStart = null;
    render();
    return;
  }
}

function onWheel(e) {
  e.preventDefault();
  closeEditor();
  const sp = getPos(e);
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = Math.min(5, Math.max(0.2, view.zoom * factor));
  const wx = (sp.x - view.panX) / view.zoom;
  const wy = (sp.y - view.panY) / view.zoom;
  view.zoom = newZoom;
  view.panX = sp.x - wx * newZoom;
  view.panY = sp.y - wy * newZoom;
  updateZoomLabel();
  render();
}

function onDblClick(e) {
  const sp = getPos(e);
  const wp = screenToWorld(sp.x, sp.y);
  const hit = hitTest(wp.x, wp.y);
  if (hit && (hit.type === 'text' || hit.type === 'sticky')) {
    selectedId = hit.id;
    openTextEditor(hit);
  }
}

function eraseAt(wx, wy) {
  const threshold = 10 / view.zoom;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (erasedThisDrag.has(it.id)) continue;
    if (hitItem(it, wx, wy, threshold)) {
      items.splice(i, 1);
      erasedThisDrag.add(it.id);
      if (selectedId === it.id) selectedId = null;
      render();
    }
  }
}

function moveItem(it, orig, dx, dy) {
  if (it.type === 'stroke') {
    for (let i = 0; i < it.points.length; i++) {
      it.points[i].x = orig.points[i].x + dx;
      it.points[i].y = orig.points[i].y + dy;
    }
  } else if (it.type === 'shape') {
    if (it.shape === 'line' || it.shape === 'arrow') {
      it.x = orig.x + dx; it.y = orig.y + dy;
      it.x2 = orig.x2 + dx; it.y2 = orig.y2 + dy;
    } else {
      it.x = orig.x + dx; it.y = orig.y + dy;
    }
  } else {
    it.x = orig.x + dx; it.y = orig.y + dy;
  }
}

// ---- Images: drag & drop ----
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const sp = getPos(e);
  const wp = screenToWorld(sp.x, sp.y);
  for (const file of files) {
    if (!file.type || !file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataURL = ev.target.result;
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        const maxDim = 420;
        if (w > maxDim || h > maxDim) {
          const s = maxDim / Math.max(w, h);
          w *= s; h *= s;
        }
        const it = { id: uid(), type: 'image', x: wp.x - w / 2, y: wp.y - h / 2, w, h, src: dataURL };
        imageCache[it.id] = img;
        items.push(it);
        selectedId = it.id;
        commit();
        render();
      };
      img.src = dataURL;
    };
    reader.readAsDataURL(file);
  }
});

function loadImages() {
  for (const it of items) {
    if (it.type === 'image' && !imageCache[it.id]) {
      const img = new Image();
      img.onload = () => render();
      img.src = it.src;
      imageCache[it.id] = img;
    }
  }
}

// ---- Text editing ----
function openTextEditor(it, isNew = false) {
  closeEditor();
  const beforeText = it.text;
  const s = worldToScreen(it.x, it.y);
  const el = document.createElement('textarea');
  el.className = 'text-editor';
  el.value = it.text;
  if (it.type === 'sticky') {
    el.style.left = (s.x + 12 * view.zoom) + 'px';
    el.style.top = (s.y + 12 * view.zoom) + 'px';
    el.style.width = (it.w * view.zoom - 24 * view.zoom) + 'px';
    el.style.height = (it.h * view.zoom - 24 * view.zoom) + 'px';
    el.style.fontSize = (16 * view.zoom) + 'px';
    el.style.background = 'transparent';
    el.style.color = '#1a1a1a';
    el.style.caretColor = '#1a1a1a';
  } else {
    el.style.left = s.x + 'px';
    el.style.top = s.y + 'px';
    el.style.color = it.color;
    el.style.caretColor = it.color;
    el.style.fontSize = (it.size * view.zoom) + 'px';
    el.style.minWidth = '140px';
  }
  document.getElementById('overlay').appendChild(el);
  editOverlay = { el, it };
  render();
  el.focus();
  let finished = false;
  el.addEventListener('input', () => { it.text = el.value; render(); });
  el.addEventListener('blur', () => {
    if (finished) return;
    finished = true;
    it.text = el.value;
    const empty = it.type === 'text' && !it.text.trim();
    if (empty) items = items.filter(x => x.id !== it.id);
    if (isNew ? !empty : (empty || it.text !== beforeText)) commit();
    closeEditor();
    render();
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' || (ev.key === 'Enter' && it.type === 'text')) {
      ev.preventDefault();
      el.blur();
    }
    // let file shortcuts through; keep every other key inside the editor
    const k = ev.key.toLowerCase();
    if (!((ev.ctrlKey || ev.metaKey) && (k === 's' || k === 'o' || k === 'e'))) ev.stopPropagation();
  });
}
function closeEditor() {
  if (editOverlay) { editOverlay.el.remove(); editOverlay = null; }
}

// ---- Zoom ----
function zoomBy(f) {
  const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
  const wx = (cx - view.panX) / view.zoom;
  const wy = (cy - view.panY) / view.zoom;
  view.zoom = Math.min(5, Math.max(0.2, view.zoom * f));
  view.panX = cx - wx * view.zoom;
  view.panY = cy - wy * view.zoom;
  updateZoomLabel();
  render();
}
function updateZoomLabel() {
  document.getElementById('zoom-level').textContent = Math.round(view.zoom * 100) + '%';
}

// ---- Theme ----
function setTheme(t) {
  theme = t;
  document.documentElement.setAttribute('data-theme', t);
  accentColor = (t === 'dark') ? '#4cc2ff' : '#0078d4';
  if (t === 'dark' && color === '#000000') color = '#ffffff';
  if (t === 'light' && color === '#ffffff') color = '#000000';
  document.querySelectorAll('#colors .swatch').forEach(s => s.classList.toggle('active', s.dataset.color === color));
  updateThemeIcon();
  try { localStorage.setItem('asterisk-theme', t); } catch (err) {}
  render();
}
function updateThemeIcon() {
  document.getElementById('btn-theme').innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;
}

// ============================================================
//  In-app dialogs (never the native Windows pop-ups)
// ============================================================
const DIALOG_ICONS = {
  info: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5.5M12 7.6v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 3.8L21 19.5H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.4M12 17.1v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
};
let modalChain = Promise.resolve();
function askDialog(opts) {
  const p = modalChain.then(() => showModal(opts));
  modalChain = p.catch(() => {});
  return p;
}
function showModal({ title, message, icon = 'info', buttons, cancelValue = null }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const prev = document.activeElement;
    root.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'modal ' + icon;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const head = document.createElement('div');
    head.className = 'modal-head';
    const ic = document.createElement('div');
    ic.className = 'modal-icon';
    ic.innerHTML = DIALOG_ICONS[icon] || DIALOG_ICONS.info;
    const h = document.createElement('h2');
    h.textContent = title;
    head.append(ic, h);
    const p = document.createElement('p');
    p.textContent = message || '';
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'mbtn' + (b.kind ? ' ' + b.kind : '');
      btn.textContent = b.label;
      btn.onclick = () => finish(b.value);
      actions.appendChild(btn);
    });
    card.append(head, p, actions);
    root.appendChild(card);
    modalOpen = true;
    root.hidden = false;
    const def = actions.querySelector('.primary, .danger') || actions.lastElementChild;
    def.focus();

    function finish(v) {
      document.removeEventListener('keydown', onKey, true);
      root.hidden = true;
      root.innerHTML = '';
      root.onmousedown = null;
      modalOpen = false;
      try { if (prev && prev.focus) prev.focus(); } catch (err) {}
      resolve(v);
    }
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); finish(cancelValue); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const bs = Array.from(actions.children);
        let i = bs.indexOf(document.activeElement);
        i = (i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length;
        bs[i].focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    root.onmousedown = (e) => { if (e.target === root) finish(cancelValue); };
  });
}
function showError(title, message) {
  return askDialog({ title, message, icon: 'error', buttons: [{ label: 'OK', value: true, kind: 'primary' }], cancelValue: true });
}

// ============================================================
//  Stabilizer - real-time tremor smoothing
//
//  Everything happens WHILE you draw; what you see is exactly what is stored.
//  There is no clean-up pass after you lift the pen.
//
//  The pen point runs through a critically-damped two-pole low-pass filter (two
//  smoothers in series). Tremor lives at roughly 4-12 Hz while deliberate strokes
//  are slower, so the cutoff is the slider: 1 = light (~14 Hz) ... 100 = strong (~3 Hz).
//  Two poles cut the shake sharply while keeping curves, loops and letters true
//  (a single pole rounds them off). When you lift the pen the tip glides the last
//  few pixels to where your hand actually stopped, so strokes never end short.
// ============================================================
const STAB_KEY = 'asterisk-stab';
const stab = { on: false, value: 50 };
try {
  const saved = JSON.parse(localStorage.getItem(STAB_KEY) || 'null');
  if (saved) {
    stab.on = !!saved.on;
    if (Number.isFinite(saved.value)) stab.value = Math.min(100, Math.max(1, Math.round(saved.value)));
    else if (saved.mode) stab.value = { low: 25, med: 50, high: 80, auto: 55 }[saved.mode] || 50;  // older builds
  }
} catch (err) {}
function saveStab() { try { localStorage.setItem(STAB_KEY, JSON.stringify({ on: stab.on, value: stab.value })); } catch (err) {} }

const lerp = (a, b, t) => a + (b - a) * t;
function stabCutoff() {
  const s = Math.max(0.01, stab.value / 100);
  return Math.exp(lerp(Math.log(14), Math.log(3), s));   // Hz
}

class Stabilizer {
  constructor(cutoff) { this.c = cutoff; this.init = false; }
  static alpha(cutoff, dt) { return 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt); }
  filter(x, y, tms) {
    if (!this.init) {
      this.init = true; this.t = tms;
      this.ax = this.bx = x; this.ay = this.by = y;
      return { x, y };
    }
    const dt = Math.max(0.001, (tms - this.t) / 1000);
    this.t = tms;
    const a = Stabilizer.alpha(this.c, dt);
    this.ax += a * (x - this.ax); this.ay += a * (y - this.ay);
    this.bx += a * (this.ax - this.bx); this.by += a * (this.ay - this.by);
    return { x: this.bx, y: this.by };
  }
  // Keep feeding the final position until the tip has arrived (a fraction of a second, computed instantly).
  settle(tx, ty, tms) {
    const out = [];
    let t = tms;
    for (let i = 0; i < 80; i++) {
      t += 8;
      const o = this.filter(tx, ty, t);
      out.push(o);
      if (Math.hypot(o.x - tx, o.y - ty) < 0.35) break;
    }
    return out;
  }
}
function makeFilter() { return new Stabilizer(stabCutoff()); }

function finishStabilized(d) {
  // the hand's resting place: average of the last few samples, so a release twitch is ignored
  const tail = strokeRaw.slice(-3);
  const tx = tail.reduce((s, p) => s + p.x, 0) / tail.length;
  const ty = tail.reduce((s, p) => s + p.y, 0) / tail.length;
  const pts = liveFilter.settle(tx, ty, tail[tail.length - 1].t);
  for (const f of pts) {
    const w = screenToWorld(f.x, f.y);
    if (d.type === 'stroke') {
      const last = d.points[d.points.length - 1];
      if (Math.hypot(w.x - last.x, w.y - last.y) > 0.4 / view.zoom) d.points.push({ x: w.x, y: w.y, p: last.p });
    } else if (d.type === 'shape') {
      if (d.shape === 'line' || d.shape === 'arrow') { d.x2 = w.x; d.y2 = w.y; }
      else { d.x = Math.min(d.sx, w.x); d.y = Math.min(d.sy, w.y); d.w = Math.abs(w.x - d.sx); d.h = Math.abs(w.y - d.sy); }
    }
  }
}

function updateStabUI() {
  const sw = document.getElementById('stab-toggle');
  sw.setAttribute('aria-checked', String(stab.on));
  const slider = document.getElementById('stab-range');
  slider.value = stab.value;
  slider.style.setProperty('--fill', ((stab.value - 1) / 99 * 100) + '%');
  document.getElementById('stab-value').textContent = stab.value;
  document.getElementById('stab-slider').classList.toggle('off', !stab.on);
}
function setStab(on) {
  stab.on = on;
  saveStab();
  updateStabUI();
  flash(on ? 'Stabilizer on' : 'Stabilizer off');
}
function setStabValue(v) {
  stab.value = Math.min(100, Math.max(1, Math.round(v)));
  if (!stab.on) stab.on = true;      // touching the slider means you want it
  saveStab();
  updateStabUI();
}

// ============================================================
//  Projects: .asterisk files (Save / Open) and PNG export
// ============================================================
const KNOWN_TYPES = ['stroke', 'shape', 'text', 'sticky', 'image'];
function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
function docName() { return currentFile ? baseName(currentFile).replace(/\.(asterisk|json)$/i, '') : 'Untitled'; }
function isDirty() { return revision !== savedRevision; }
function updateDirtyUI() {
  const dirty = isDirty();
  document.getElementById('doc-name').textContent = docName();
  document.getElementById('dirty-dot').hidden = !dirty;
  document.getElementById('title-dot').hidden = !dirty;
  const t = (dirty ? '\u2022 ' : '') + docName() + ' \u2013 Asterisk';
  document.title = t;
  if (window.api) window.api.setTitle(t);
}

function sanitizeItems(arr) {
  const out = [];
  for (const it of Array.isArray(arr) ? arr : []) {
    if (!it || typeof it !== 'object' || !KNOWN_TYPES.includes(it.type)) continue;
    if (typeof it.id !== 'string' || !it.id) it.id = uid();
    if (it.type === 'stroke') {
      if (!Array.isArray(it.points)) continue;
      it.points = it.points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map(p => ({ x: p.x, y: p.y, p: Number.isFinite(p.p) ? p.p : 0.5 }));
      if (!it.points.length) continue;
      if (!Number.isFinite(it.size)) it.size = 4;
      if (typeof it.color !== 'string') it.color = '#000000';
    }
    if (it.type === 'image' && !(typeof it.src === 'string' && it.src.startsWith('data:image/'))) continue;
    out.push(it);
  }
  return out;
}

function loadProject(data, filePath) {
  closeEditor();
  items = sanitizeItems(data.items);
  const v = data.view || {};
  view = { panX: Number.isFinite(v.panX) ? v.panX : 0, panY: Number.isFinite(v.panY) ? v.panY : 0, zoom: Math.min(5, Math.max(0.2, Number.isFinite(v.zoom) ? v.zoom : 1)) };
  for (const k of Object.keys(imageCache)) delete imageCache[k];
  currentFile = filePath || null;
  selectedId = null;
  loadImages();
  resetHistory();
  savedRevision = revision;
  updateZoomLabel();
  updateDirtyUI();
  render();
}

async function saveProject({ saveAs = false } = {}) {
  if (editOverlay) editOverlay.el.blur();
  let res;
  try {
    res = await window.api.saveProject({ data: { items, view, theme }, filePath: currentFile, saveAs, suggestedName: docName() });
  } catch (err) { res = { saved: false, error: err.message }; }
  if (res.saved) {
    currentFile = res.filePath;
    savedRevision = revision;
    updateDirtyUI();
    flash('Saved ' + baseName(res.filePath));
    return true;
  }
  if (res.error) await showError('Couldn\u2019t save the project', res.error);
  return false;
}

// Ask what to do with unsaved work. Resolves true when it is safe to continue.
async function confirmUnsaved(what) {
  if (!isDirty()) return true;
  const r = await askDialog({
    title: 'Save your changes?',
    message: '\u201c' + docName() + '\u201d has changes that haven\u2019t been saved. ' + what,
    icon: 'warn',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Don\u2019t save', value: 'discard' },
      { label: 'Save', value: 'save', kind: 'primary' }
    ],
    cancelValue: 'cancel'
  });
  if (r === 'cancel') return false;
  if (r === 'save') return await saveProject();
  return true;
}

async function openProject() {
  if (editOverlay) editOverlay.el.blur();
  if (!(await confirmUnsaved('Opening another project will discard them.'))) return;
  let res;
  try { res = await window.api.openProject(); } catch (err) { res = { loaded: false, error: err.message }; }
  if (res.loaded) { loadProject(res.data, res.filePath); flash('Opened ' + baseName(res.filePath)); }
  else if (res.error) await showError('Couldn\u2019t open that file', res.error);
}

async function clearBoard() {
  if (items.length === 0) { flash('The board is already empty'); return; }
  const r = await askDialog({
    title: 'Clear the board?',
    message: 'This removes everything on the board. You can bring it back with Undo (Ctrl+Z).',
    icon: 'warn',
    buttons: [{ label: 'Cancel', value: false }, { label: 'Clear board', value: true, kind: 'danger' }],
    cancelValue: false
  });
  if (!r) return;
  items = [];
  selectedId = null;
  commit();
  render();
  flash('Board cleared');
}

async function exportPNG() {
  if (items.length === 0) { flash('Nothing to export'); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    const b = itemBounds(it);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const w = maxX - minX, h = maxY - minY;
  const scale = 2;
  const off = document.createElement('canvas');
  off.width = Math.round(w * scale); off.height = Math.round(h * scale);
  const c = off.getContext('2d');
  c.fillStyle = THEME[theme].canvasBg;
  c.fillRect(0, 0, off.width, off.height);
  c.scale(scale, scale);
  c.translate(-minX, -minY);
  for (const it of items) drawItem(c, it);
  let res;
  try { res = await window.api.exportPNG({ dataUrl: off.toDataURL('image/png'), suggestedName: docName() }); }
  catch (err) { res = { saved: false, error: err.message }; }
  if (res.saved) flash('Exported ' + baseName(res.filePath));
  else if (res.error) await showError('Couldn\u2019t export the image', res.error);
}

let flashTimer;
function flash(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---- UI wiring ----
function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  const showProps = ['pen', 'highlighter', 'shape', 'text'].includes(t);
  document.getElementById('stab-row').style.display = ['pen', 'highlighter', 'shape'].includes(t) ? 'flex' : 'none';
  document.getElementById('props').style.display = showProps ? 'flex' : 'none';
  document.getElementById('shape-row').style.display = t === 'shape' ? 'flex' : 'none';
  document.getElementById('sticky-colors').style.display = t === 'sticky' ? 'flex' : 'none';
  canvas.style.cursor = t === 'select' ? 'default' : (t === 'text' ? 'text' : 'crosshair');
}

document.querySelectorAll('[data-tool]').forEach(btn => {
  btn.onclick = () => setTool(btn.dataset.tool);
});
document.querySelectorAll('[data-shape]').forEach(btn => {
  btn.onclick = () => {
    shapeType = btn.dataset.shape;
    document.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('active', b.dataset.shape === shapeType));
  };
});

// colors
const colorWrap = document.getElementById('colors');
COLORS.forEach(c => {
  const b = document.createElement('button');
  b.className = 'swatch' + (c === color ? ' active' : '');
  b.style.background = c;
  b.dataset.color = c;
  b.onclick = () => {
    color = c;
    document.querySelectorAll('#colors .swatch').forEach(s => s.classList.toggle('active', s.dataset.color === c));
    if (selectedId) {
      const it = items.find(i => i.id === selectedId);
      if (it && (it.type === 'stroke' || it.type === 'shape' || it.type === 'text')) {
        it.color = c;
        commit();
        render();
      }
    }
  };
  colorWrap.appendChild(b);
});

// sticky colors
const stickyWrap = document.getElementById('sticky-colors');
STICKY_COLORS.forEach(c => {
  const b = document.createElement('button');
  b.className = 'sticky-swatch';
  b.style.background = c;
  b.dataset.color = c;
  b.onclick = () => {
    document.querySelectorAll('#sticky-colors .sticky-swatch').forEach(s => s.classList.toggle('active', s === b));
    if (selectedId) {
      const it = items.find(i => i.id === selectedId);
      if (it && it.type === 'sticky') { it.color = c; commit(); render(); }
    }
  };
  stickyWrap.appendChild(b);
});

// sizes
document.querySelectorAll('#sizes button').forEach(btn => {
  btn.onclick = () => {
    size = parseInt(btn.dataset.size, 10);
    document.querySelectorAll('#sizes button').forEach(b => b.classList.toggle('active', b === btn));
    if (selectedId) {
      const it = items.find(i => i.id === selectedId);
      if (it && (it.type === 'stroke' || it.type === 'shape')) { it.size = size; commit(); render(); }
    }
  };
});

// zoom
document.getElementById('zoom-in').onclick = () => zoomBy(1.2);
document.getElementById('zoom-out').onclick = () => zoomBy(1 / 1.2);
document.getElementById('zoom-reset').onclick = () => { view.zoom = 1; view.panX = 0; view.panY = 0; updateZoomLabel(); render(); };

// history
document.getElementById('btn-undo').onclick = undo;
document.getElementById('btn-redo').onclick = redo;

// theme
document.getElementById('btn-theme').onclick = () => setTheme(theme === 'dark' ? 'light' : 'dark');

// window controls
document.getElementById('win-min').onclick = () => window.api && window.api.minimize();
document.getElementById('win-max').onclick = () => window.api && window.api.maximize();
document.getElementById('win-close').onclick = () => window.api && window.api.close();
if (window.api) {
  window.api.isMaximized().then((m) => {
    document.getElementById('win-max').innerHTML = m ? RESTORE_ICON : MAX_ICON;
  });
  window.api.onMaximizedChange((m) => {
    document.getElementById('win-max').innerHTML = m ? RESTORE_ICON : MAX_ICON;
  });
}

// file ops
document.getElementById('btn-save').onclick = (e) => saveProject({ saveAs: e.shiftKey });
document.getElementById('btn-open').onclick = openProject;
document.getElementById('btn-export').onclick = exportPNG;
document.getElementById('btn-clear').onclick = clearBoard;

// stabilizer
document.getElementById('stab-toggle').onclick = () => setStab(!stab.on);
document.getElementById('stab-range').addEventListener('input', (e) => setStabValue(Number(e.target.value)));

// keyboard
window.addEventListener('keydown', (e) => {
  if (modalOpen) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); saveProject({ saveAs: e.shiftKey }); return; }
  if (mod && k === 'o') { e.preventDefault(); openProject(); return; }
  if (mod && k === 'e') { e.preventDefault(); exportPNG(); return; }
  if (editOverlay) return;
  if (mod && k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedId) {
      items = items.filter(i => i.id !== selectedId);
      selectedId = null;
      commit(); render();
    }
    return;
  }
  if (e.key === 'Escape') { selectedId = null; render(); return; }
  if (k === 'v') setTool('select');
  else if (k === 'p') setTool('pen');
  else if (k === 'h') setTool('highlighter');
  else if (k === 'e') setTool('eraser');
  else if (k === 's') setTool('shape');
  else if (k === 't') setTool('text');
  else if (k === 'n') setTool('sticky');
  else if (k === 'a') setStab(!stab.on);
  else if (k === '+' || k === '=') zoomBy(1.2);
  else if (k === '-') zoomBy(1 / 1.2);
});

// ---- Init ----
async function init() {
  resize();
  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem('asterisk-theme') || 'light'; } catch (err) {}
  setTheme(savedTheme);
  resetHistory();
  savedRevision = revision;
  setTool('pen');
  updateZoomLabel();
  updateStabUI();
  updateDirtyUI();
  render();

  if (!window.api) return;
  window.api.onCloseRequest(async () => { if (await confirmUnsaved('Closing will discard them.')) window.api.closeNow(); });
  window.api.onReloadRequest(async () => { if (await confirmUnsaved('Reloading will discard them.')) window.api.reloadNow(); });
  window.api.onError((e) => showError(e.title || 'Something went wrong', e.message));
  window.addEventListener('error', (ev) => showError('Something went wrong', ev.message));
  window.addEventListener('unhandledrejection', (ev) => showError('Something went wrong', (ev.reason && ev.reason.message) || String(ev.reason)));

  try {
    const initial = await window.api.getInitialFile();
    if (initial && initial.loaded) loadProject(initial.data, initial.filePath);
    else if (initial && initial.error) showError('Couldn\u2019t open that file', initial.error);
  } catch (err) {}
}
init();
