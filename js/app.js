import { clipSegmentToRect, dist, v } from "./geom.js";
import {
  ANCHOR_CORNERS,
  BOX_EDGES,
  DERIVED_CORNERS,
  applyCornerDrag,
  applyVPDrag,
  defaultCorners,
  estimateVanishingPoints,
  resetVPSolver,
  restoreVPs,
  setVPPolar,
  snapshotVPs,
  syncCuboid,
  visibleFaces,
  vpPolar,
  translateBoxKeepingVPs,
} from "./cuboid.js";
import { drawAxisGrid, drawVP } from "./grid.js";
import { clearHistory, commit, redo, undo } from "./history.js";
import {
  boxCenter,
  boxHull,
  createDefaultLayers,
  createImageLayer,
  hueToColor,
  imageBounds,
  imageCenter,
  moveLayer,
  pointInImage,
  pointInPolygon,
  removeLayer,
  updateLayer,
} from "./layers.js";

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const spacingInput = document.getElementById("spacing");
const spacingVal = document.getElementById("spacing-val");
const resetBtn = document.getElementById("reset-btn");
const toggleBtn = document.getElementById("toggle-toolbox");
const helpBtn = document.getElementById("help-btn");
const helpModal = document.getElementById("help-modal");
const toolbox = document.getElementById("toolbox");
const uploadInput = document.getElementById("upload");
const layersList = document.getElementById("layers-list");

const HIT_RADIUS_PX = 12;
const GIZMO_RADIUS_PX = 14;
const VP_HIT_RADIUS_PX = 14;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 40;

let panX = 0;
let panY = 0;
let zoom = 1;
let corners = [];
let layers = createDefaultLayers();

let dragCorner = -1;
let dragGizmoLayerId = null;
let dragGizmoStart = null;
let dragGizmoOrigin = null;
let panning = false;
let panStart = null;
let panOrigin = null;
let hoveredLayerId = null;
let openHueLayerId = null;
let hoveredVPAxis = null;
let dragVPAxis = null;
let vpDragSeed = null;

function viewSize() {
  const dpr = window.devicePixelRatio || 1;
  return { w: canvas.width / dpr, h: canvas.height / dpr };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  // Short-circuit if nothing changed. ResizeObserver can fire spuriously
  // (subpixel layout jitter, etc.) and re-setting canvas.width/height clears
  // the canvas and forces a redraw — which during a drag manifests as
  // every-frame stalls because we end up resizing twice per pointermove.
  if (canvas.width === targetW && canvas.height === targetH) {
    if (!corners.length) {
      resetBox();
      draw();
    }
    return;
  }
  canvas.width = targetW;
  canvas.height = targetH;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!corners.length) {
    resetBox();
  }
  draw();
}

function resetBox() {
  const { w, h } = viewSize();
  const wc = screenToWorld(w / 2, h / 2);
  const s = Math.min(w, h) / zoom * 0.12;
  resetVPSolver();
  corners = defaultCorners(wc.x, wc.y, s);
  syncCuboid(corners, wc);
}

/**
 * Snapshot of all "document state" — what undo/redo restores. Pan/zoom and
 * transient UI (openHueLayerId, hover states) are deliberately excluded;
 * they're not user-authored content.
 *
 * Layer image references are aliased, not cloned: HTMLImageElement is
 * immutable bitmap data so sharing is safe and cheap.
 */
function snapshotState() {
  return {
    corners: corners.map((p) => ({ x: p.x, y: p.y })),
    vps: snapshotVPs(),
    layers: layers.map(cloneLayer),
    spacing: spacingInput.value,
  };
}

function cloneLayer(l) {
  const out = { ...l };
  if (l.pos) out.pos = { ...l.pos };
  if (l.axes) out.axes = [...l.axes];
  return out;
}

function restoreState(snap) {
  corners = snap.corners.map((p) => ({ x: p.x, y: p.y }));
  restoreVPs(snap.vps);
  layers = snap.layers.map(cloneLayer);
  spacingInput.value = snap.spacing;
  spacingVal.textContent = snap.spacing;
  openHueLayerId = null;
  dragCorner = -1;
  dragGizmoLayerId = null;
  dragVPAxis = null;
  pendingPreSnap = null;
  pendingSliderSnap = null;
  dragMoved = false;
  renderLayerList();
  draw();
}

// Commit the *pre-action* state into the undo stack. Always pair with
// "snapshot first, then mutate" at the action site.
function commitPre(snap) {
  if (snap) commit(snap);
}

// Drag state: captured on pointerdown for any document-mutating drag; pushed
// to history on pointerup only if a pointermove actually fired.
let pendingPreSnap = null;
let dragMoved = false;

// Multi-touch gesture state. activePointers maps pointerId -> last screen
// position; gesture is set when >=2 pointers are down. Single-pointer logic
// (drags, pan) is suspended while a gesture is active.
const activePointers = new Map();
let gesture = null;

function pointerScreenPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// Centroid + a representative scale (mean distance from centroid). Works for
// any number of pointers >=2 and degrades gracefully when fingers are added
// or removed (re-anchor on count change keeps motion continuous).
function gestureMetrics() {
  const ps = [...activePointers.values()];
  let cx = 0;
  let cy = 0;
  for (const p of ps) {
    cx += p.x;
    cy += p.y;
  }
  cx /= ps.length;
  cy /= ps.length;
  let spread = 0;
  for (const p of ps) spread += Math.hypot(p.x - cx, p.y - cy);
  spread = Math.max(spread / ps.length, 1);
  return { center: { x: cx, y: cy }, spread };
}

function beginGesture() {
  const m = gestureMetrics();
  gesture = {
    spreadStart: m.spread,
    zoomStart: zoom,
    worldStart: screenToWorld(m.center.x, m.center.y),
  };
}

function cancelSinglePointerInteractions() {
  pendingPreSnap = null;
  dragMoved = false;
  dragCorner = -1;
  dragGizmoLayerId = null;
  dragGizmoStart = null;
  dragGizmoOrigin = null;
  dragVPAxis = null;
  vpDragSeed = null;
  panning = false;
  panStart = null;
}

// Slider/color-picker state: captured on first "input", pushed on "change"
// (which fires once at gesture end for both <input type="range"> and "color").
let pendingSliderSnap = null;

function beginSliderEdit() {
  if (!pendingSliderSnap) pendingSliderSnap = snapshotState();
}

function endSliderEdit() {
  if (pendingSliderSnap) {
    commitPre(pendingSliderSnap);
    pendingSliderSnap = null;
  }
}

function screenToWorld(sx, sy) {
  return v((sx - panX) / zoom, (sy - panY) / zoom);
}

function worldToScreen(p) {
  return v(p.x * zoom + panX, p.y * zoom + panY);
}

function principalPoint(w, h) {
  return screenToWorld(w / 2, h / 2);
}

function viewportWorldRect(w, h, margin = 400) {
  const tl = screenToWorld(-margin, -margin);
  const br = screenToWorld(w + margin, h + margin);
  return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
}

/**
 * Split segment p0→p1 by triangle `tri` into runs of "inside" / "outside"
 * subsegments (in p0→p1 parameter space). Returns 1–3 entries, each
 * { t0, t1, inside }, in order along the segment. Triangle edges are tested
 * as line segments; an intersection counts only when it lies on the triangle
 * side as well (not just the extended line), so a box edge that misses the
 * triangle laterally produces a single "outside" run.
 */
function splitSegmentByTriangle(p0, p1, tri) {
  const ts = [0, 1];
  const dx1 = p1.x - p0.x;
  const dy1 = p1.y - p0.y;
  for (let i = 0; i < 3; i++) {
    const a = tri[i];
    const b = tri[(i + 1) % 3];
    const dx2 = b.x - a.x;
    const dy2 = b.y - a.y;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 1e-9) continue; // parallel
    const t = ((a.x - p0.x) * dy2 - (a.y - p0.y) * dx2) / denom;
    const s = ((a.x - p0.x) * dy1 - (a.y - p0.y) * dx1) / denom;
    if (t > 1e-6 && t < 1 - 1e-6 && s >= 0 && s <= 1) ts.push(t);
  }
  ts.sort((u, v) => u - v);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const tm = (ts[i] + ts[i + 1]) * 0.5;
    const mid = { x: p0.x + dx1 * tm, y: p0.y + dy1 * tm };
    out.push({ t0: ts[i], t1: ts[i + 1], inside: pointInTriangle(mid, tri) });
  }
  return out;
}

// Same-side test: q is inside iff it's on the same side of each edge as the
// opposite vertex. Robust to triangle winding.
function pointInTriangle(q, tri) {
  const sign = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
  const d0 = sign(q, tri[0], tri[1]);
  const d1 = sign(q, tri[1], tri[2]);
  const d2 = sign(q, tri[2], tri[0]);
  const hasNeg = d0 < 0 || d1 < 0 || d2 < 0;
  const hasPos = d0 > 0 || d1 > 0 || d2 > 0;
  return !(hasNeg && hasPos);
}

function drawBoxLayer(layer, vps, lineScale, handleScale, hovered) {
  const rect = viewportWorldRect(viewSize().w, viewSize().h, 400);

  // Translucent hull fill on hover so the draggable region is obvious.
  if (hovered) {
    const hull = boxHull(corners);
    if (hull.length >= 3) {
      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
      ctx.beginPath();
      ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // Tint each front-facing face in the color of the axis it's perpendicular
  // to (so vx-normal faces match the Vx grid color, etc.). Front-only fills
  // partition the silhouette cleanly into 1–3 non-overlapping regions, which
  // both communicates orientation and avoids the "fill everything = solid
  // box" pitfall you get when both sides paint over each other.
  const front = visibleFaces(corners, vps);
  if (front.length) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * 0.35;
    for (const { corners: f, axis } of front) {
      ctx.fillStyle = gridLayerColor(axis);
      ctx.beginPath();
      ctx.moveTo(corners[f[0]].x, corners[f[0]].y);
      for (let i = 1; i < f.length; i++) ctx.lineTo(corners[f[i]].x, corners[f[i]].y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.strokeStyle = layer.color;
  ctx.lineWidth = (hovered ? 2.5 : 2) * lineScale;
  // Triangle is only defined when all three VPs are finite. When it's
  // available, edges (or parts of edges) that lie outside it get dashed —
  // signalling that the projection is degenerate over there.
  const tri = vps.vx?.finite && vps.vy?.finite && vps.vz?.finite
    ? [vps.vx.p, vps.vy.p, vps.vz.p]
    : null;
  const dashOut = [6 * lineScale, 4 * lineScale];
  for (const [a, b] of BOX_EDGES) {
    const p0 = corners[a];
    const p1 = corners[b];
    const segs = tri ? splitSegmentByTriangle(p0, p1, tri) : [{ t0: 0, t1: 1, inside: true }];
    for (const seg of segs) {
      const q0 = { x: p0.x + (p1.x - p0.x) * seg.t0, y: p0.y + (p1.y - p0.y) * seg.t0 };
      const q1 = { x: p0.x + (p1.x - p0.x) * seg.t1, y: p0.y + (p1.y - p0.y) * seg.t1 };
      const clipped = clipSegmentToRect(q0, q1, rect.x0, rect.y0, rect.x1, rect.y1);
      if (!clipped) continue;
      ctx.setLineDash(seg.inside ? [] : dashOut);
      ctx.beginPath();
      ctx.moveTo(clipped[0].x, clipped[0].y);
      ctx.lineTo(clipped[1].x, clipped[1].y);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  for (let i = 0; i < 8; i++) {
    const p = corners[i];
    if (p.x < rect.x0 || p.x > rect.x1 || p.y < rect.y0 || p.y > rect.y1) continue;
    const isAnchor = ANCHOR_CORNERS.includes(i);
    const isAuto = i === 7;
    const isDrag = i === dragCorner;
    const isOrigin = i === 0;
    ctx.fillStyle = isDrag ? "#fff" : isAuto ? "#444" : isAnchor ? "#eee" : "#888";
    const r = (isDrag ? 7 : isAuto ? 3 : isAnchor ? 6 : 5) * handleScale;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Highlight c0 as the convergence point of all three grid fans.
    if (isOrigin) {
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = 1.5 * handleScale;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5 * handleScale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawGridLayer(layer, vps, divisions, lineScale, rect, anchor) {
  const vp = { x: vps.vx, y: vps.vy, z: vps.vz }[layer.axis];
  drawAxisGrid(ctx, vp, divisions, layer.color, lineScale, rect, anchor);
}

function gridLayerColor(axis) {
  return layers.find((l) => l.type === "grid" && l.axis === axis)?.color ?? "#888";
}

/**
 * "Horizon" between two VPs: line through both VP positions, drawn as a
 * solid gradient segment between them and dashed extensions beyond each VP.
 * Color stops match each VP's grid-layer color, so the line literally fades
 * from one axis' hue into the other.
 */
function drawHorizonLayer(layer, vps, lineScale, rect) {
  const [ax0, ax1] = layer.axes;
  const a = vps[`v${ax0}`];
  const b = vps[`v${ax1}`];
  if (!a?.finite || !b?.finite) return;
  const pA = a.p;
  const pB = b.p;
  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;

  // Extend the line well past both VPs so the dashed segments reach beyond
  // the viewport even when a VP sits far outside it.
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const diag = Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0);
  const distA = Math.hypot(pA.x - cx, pA.y - cy);
  const distB = Math.hypot(pB.x - cx, pB.y - cy);
  const big = Math.max(diag, distA, distB) * 4;
  const outerA = { x: pA.x - ux * big, y: pA.y - uy * big };
  const outerB = { x: pB.x + ux * big, y: pB.y + uy * big };

  const colA = gridLayerColor(ax0);
  const colB = gridLayerColor(ax1);
  const stroke = (from, to, style, dashed) => {
    const clip = clipSegmentToRect(from, to, rect.x0, rect.y0, rect.x1, rect.y1);
    if (!clip) return;
    ctx.strokeStyle = style;
    ctx.lineWidth = 1.5 * lineScale;
    ctx.setLineDash(dashed ? [6 * lineScale, 4 * lineScale] : []);
    ctx.beginPath();
    ctx.moveTo(clip[0].x, clip[0].y);
    ctx.lineTo(clip[1].x, clip[1].y);
    ctx.stroke();
  };

  ctx.save();
  stroke(outerA, pA, colA, true);
  // Gradient anchored at the actual VPs (not the clipped endpoints) so the
  // hue ramp stays oriented correctly regardless of which side is visible.
  const grad = ctx.createLinearGradient(pA.x, pA.y, pB.x, pB.y);
  grad.addColorStop(0, colA);
  grad.addColorStop(1, colB);
  stroke(pA, pB, grad, false);
  stroke(pB, outerB, colB, true);
  ctx.restore();
}

/**
 * Closed triangle through the three VPs — the camera's cone of vision. Inside
 * the triangle the implied pinhole projection is well-behaved; outside it the
 * projection degenerates (foreshortening goes hyperbolic, faces flip). Edges
 * adjacent to a VP-at-infinity are skipped (the triangle isn't well-defined).
 */
function drawVPTriangleLayer(layer, vps, lineScale) {
  const pts = [vps.vx, vps.vy, vps.vz];
  if (pts.some((vp) => !vp?.finite)) return;
  const [a, b, c] = pts.map((vp) => vp.p);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.closePath();
  // Faint interior fill so "inside vs outside" reads at a glance, plus a
  // crisper outline.
  const savedAlpha = ctx.globalAlpha;
  ctx.fillStyle = layer.color;
  ctx.globalAlpha = savedAlpha * 0.08;
  ctx.fill();
  ctx.globalAlpha = savedAlpha;
  ctx.strokeStyle = layer.color;
  ctx.lineWidth = 1.25 * lineScale;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.restore();
}

function drawImageLayer(layer) {
  ctx.drawImage(
    layer.image,
    layer.pos.x,
    layer.pos.y,
    layer.width * layer.scale,
    layer.height * layer.scale,
  );
}

function drawGizmo(center, handleScale, active) {
  const r = GIZMO_RADIUS_PX * handleScale;
  ctx.save();
  // Circular background = hit affordance.
  ctx.fillStyle = active ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.18)";
  ctx.strokeStyle = active ? "#fff" : "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1.5 * handleScale;
  ctx.beginPath();
  ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Four-way drag arrow (≈ fa-arrows-up-down-left-right).
  const fg = active ? "#222" : "rgba(0,0,0,0.75)";
  const arm = r * 0.68;
  const head = r * 0.32;
  const halfW = head * 0.62;
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.fillStyle = fg;
  ctx.strokeStyle = fg;
  ctx.lineWidth = 1.6 * handleScale;
  ctx.lineCap = "round";
  // Cross arms: line from one arrowhead base through the center to the
  // opposite arrowhead base. Drawn as two strokes (horizontal + vertical).
  ctx.beginPath();
  ctx.moveTo(-arm + head, 0); ctx.lineTo(arm - head, 0);
  ctx.moveTo(0, -arm + head); ctx.lineTo(0, arm - head);
  ctx.stroke();
  // Arrowheads at the four cardinal directions.
  const drawHead = (ang) => {
    ctx.save();
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(arm, 0);
    ctx.lineTo(arm - head, -halfW);
    ctx.lineTo(arm - head, halfW);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  drawHead(0);
  drawHead(Math.PI);
  drawHead(-Math.PI / 2);
  drawHead(Math.PI / 2);
  ctx.restore();

  ctx.restore();
}

function layerGizmoCenter(layer) {
  if (layer.type === "image") return imageCenter(layer);
  if (layer.type === "box") return boxCenter(corners);
  return null;
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = viewSize();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Background layer paints first; if it's hidden the canvas stays
  // transparent (showing whatever the page CSS underneath is).
  ctx.clearRect(0, 0, w, h);
  const bg = layers.find((l) => l.type === "background");
  if (bg && bg.visible) {
    ctx.save();
    ctx.globalAlpha = bg.opacity;
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  const lineScale = 1 / zoom;
  const handleScale = 1 / zoom;
  const vps = estimateVanishingPoints(corners, principalPoint(w, h));
  const divisions = parseInt(spacingInput.value, 10) || 8;
  // Grids and box-edge clipping use the same viewport rect so they extend
  // exactly to the visible region (plus a small margin) regardless of pan.
  const gridRect = viewportWorldRect(w, h, 200);

  for (const layer of layers) {
    if (!layer.visible) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    switch (layer.type) {
      case "background": break; // painted before the world transform
      case "grid": drawGridLayer(layer, vps, divisions, lineScale, gridRect, corners[0]); break;
      case "horizon": drawHorizonLayer(layer, vps, lineScale, gridRect); break;
      case "vp-triangle": drawVPTriangleLayer(layer, vps, lineScale); break;
      case "box": {
        const boxHovered = hoveredLayerId === layer.id || dragGizmoLayerId === layer.id;
        drawBoxLayer(layer, vps, lineScale, handleScale, boxHovered);
        break;
      }
      case "image": drawImageLayer(layer); break;
    }
    ctx.restore();
  }

  // VP markers on top of grids; tint with the corresponding grid layer color
  // so they read as the X/Y/Z handles for that axis.
  ctx.save();
  const vpActive = dragVPAxis ?? hoveredVPAxis;
  drawVP(ctx, vps.vx, "Vx", gridLayerColor("x"), handleScale, vpActive === "x");
  drawVP(ctx, vps.vy, "Vy", gridLayerColor("y"), handleScale, vpActive === "y");
  drawVP(ctx, vps.vz, "Vz", gridLayerColor("z"), handleScale, vpActive === "z");
  ctx.restore();

  // Gizmo for hovered or dragging layer
  const gizmoLayerId = dragGizmoLayerId ?? hoveredLayerId;
  if (gizmoLayerId) {
    const layer = layers.find((l) => l.id === gizmoLayerId);
    if (layer && layer.visible) {
      const center = layerGizmoCenter(layer);
      if (center) drawGizmo(center, handleScale, dragGizmoLayerId === gizmoLayerId);
    }
  }

  ctx.restore();

  // Off-canvas / at-infinity VP indicators are drawn in screen space (after
  // the world transform is undone) so they stay a fixed pixel size.
  drawOffscreenVPIndicators(vps, w, h);

  // Keep the toolbox VP sliders in sync with whatever the user did on canvas.
  syncVPSliders();
}

/**
 * For each VP that's off-canvas or at infinity, draw a small arrow at the
 * canvas edge pointing toward it, labeled with its name in its axis color.
 */
function drawOffscreenVPIndicators(vps, w, h) {
  const inset = 28;
  const cx = w / 2;
  const cy = h / 2;
  for (const axis of ["x", "y", "z"]) {
    const vp = vps[`v${axis}`];
    if (!vp) continue;

    let dirX;
    let dirY;
    if (vp.finite) {
      const sp = worldToScreen(vp.p);
      // On-canvas? regular VP marker is already drawn; skip the indicator.
      if (sp.x >= 0 && sp.x <= w && sp.y >= 0 && sp.y <= h) continue;
      dirX = sp.x - cx;
      dirY = sp.y - cy;
    } else {
      dirX = vp.dir.x;
      dirY = vp.dir.y;
    }
    const len = Math.hypot(dirX, dirY);
    if (len < 1e-9) continue;
    const ux = dirX / len;
    const uy = dirY / len;

    // Ray from center hits the inset rect at parameter t > 0.
    let t = Infinity;
    if (ux > 1e-9) t = Math.min(t, (w - inset - cx) / ux);
    else if (ux < -1e-9) t = Math.min(t, (inset - cx) / ux);
    if (uy > 1e-9) t = Math.min(t, (h - inset - cy) / uy);
    else if (uy < -1e-9) t = Math.min(t, (inset - cy) / uy);
    if (!Number.isFinite(t) || t <= 0) continue;

    const tipX = cx + ux * t;
    const tipY = cy + uy * t;
    const color = gridLayerColor(axis);

    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(Math.atan2(uy, ux));
    // Arrowhead: tip at (0,0) pointing along +x, body extending back.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-12, -7);
    ctx.lineTo(-12, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Label placed inward from the arrowhead, kept upright (no rotation).
    const label = `V${axis}${vp.finite ? "" : " ∞"}`;
    const lx = tipX - ux * 22;
    const ly = tipY - uy * 22;
    ctx.save();
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = color;
    ctx.fillText(label, lx, ly);
    ctx.restore();
  }
}

/** c7 is auto-computed — dragging it inherently amplifies the box, so skip hits. */
const DRAGGABLE = [0, 1, 2, 3, 4, 5, 6];

function hitCorner(sx, sy) {
  const p = screenToWorld(sx, sy);
  const radius = HIT_RADIUS_PX / zoom;
  const boxLayer = layers.find((l) => l.type === "box");
  if (!boxLayer || !boxLayer.visible) return -1;
  // Derived first so c5/c6/c3 take priority over a nearby anchor.
  const order = [3, 5, 6, 0, 1, 2, 4];
  for (const i of order) {
    if (dist(p, corners[i]) <= radius) return i;
  }
  return -1;
}

function hitGizmo(sx, sy, layerId) {
  if (!layerId) return false;
  const layer = layers.find((l) => l.id === layerId);
  if (!layer || !layer.visible) return false;
  const center = layerGizmoCenter(layer);
  if (!center) return false;
  const screen = worldToScreen(center);
  return Math.hypot(sx - screen.x, sy - screen.y) <= GIZMO_RADIUS_PX;
}

function hitLayer(sx, sy) {
  const wp = screenToWorld(sx, sy);
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer.visible) continue;
    if (layer.type === "image" && pointInImage(wp, layer)) return layer.id;
    if (layer.type === "box" && pointInPolygon(wp, boxHull(corners))) return layer.id;
  }
  return null;
}

function currentVPs() {
  const { w, h } = viewSize();
  return estimateVanishingPoints(corners, principalPoint(w, h));
}

function hitVP(sx, sy) {
  const vps = currentVPs();
  const wp = screenToWorld(sx, sy);
  const radius = VP_HIT_RADIUS_PX / zoom;
  for (const axis of ["x", "y", "z"]) {
    const vp = vps[`v${axis}`];
    if (!vp?.finite) continue;
    if (Math.abs(vp.p.x) > 1e6 || Math.abs(vp.p.y) > 1e6) continue;
    if (dist(wp, vp.p) <= radius) return { axis, vps };
  }
  return null;
}

function beginGizmoDrag(layerId, sx, sy, pointerId) {
  dragGizmoLayerId = layerId;
  dragGizmoStart = screenToWorld(sx, sy);
  const layer = layers.find((l) => l.id === dragGizmoLayerId);
  if (layer.type === "image") {
    dragGizmoOrigin = { x: layer.pos.x, y: layer.pos.y };
  } else if (layer.type === "box") {
    dragGizmoOrigin = corners.map((p) => ({ x: p.x, y: p.y }));
  }
  canvas.setPointerCapture(pointerId);
}

canvas.addEventListener("pointerdown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  activePointers.set(e.pointerId, { x: sx, y: sy });
  if (activePointers.size >= 2) {
    // Second (or third+) finger arriving: abandon any single-finger drag and
    // re-anchor the pinch/pan gesture so it picks up from the current view.
    cancelSinglePointerInteractions();
    beginGesture();
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "default";
    return;
  }

  // 1. VP handles take priority over everything else (they may sit anywhere,
  //    including inside the box hull or out in empty space).
  const vp = hitVP(sx, sy);
  if (vp) {
    dragVPAxis = vp.axis;
    vpDragSeed = vp.vps;
    hoveredLayerId = null;
    pendingPreSnap = snapshotState();
    dragMoved = false;
    canvas.setPointerCapture(e.pointerId);
    draw();
    return;
  }

  // 2. Corner handles (smallest, most precise).
  const corner = hitCorner(sx, sy);
  if (corner >= 0) {
    dragCorner = corner;
    hoveredLayerId = null;
    pendingPreSnap = snapshotState();
    dragMoved = false;
    canvas.setPointerCapture(e.pointerId);
    draw();
    return;
  }

  // 3. Anywhere on a draggable layer drags it.
  const layerId =
    hitLayer(sx, sy) ??
    (hoveredLayerId && hitGizmo(sx, sy, hoveredLayerId) ? hoveredLayerId : null);
  if (layerId) {
    hoveredLayerId = layerId;
    pendingPreSnap = snapshotState();
    dragMoved = false;
    beginGizmoDrag(layerId, sx, sy, e.pointerId);
    return;
  }

  // 4. Empty space → pan. Pan/zoom isn't part of document history.
  hoveredLayerId = null;
  panning = true;
  panStart = v(sx, sy);
  panOrigin = v(panX, panY);
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: sx, y: sy });
  }
  if (gesture && activePointers.size >= 2) {
    const m = gestureMetrics();
    const scale = m.spread / gesture.spreadStart;
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, gesture.zoomStart * scale));
    // Keep the world point that was under the gesture centroid at start
    // glued to the current centroid: pan = center - worldStart * zoom.
    panX = m.center.x - gesture.worldStart.x * zoom;
    panY = m.center.y - gesture.worldStart.y * zoom;
    draw();
    return;
  }

  if (dragVPAxis) {
    applyVPDrag(corners, dragVPAxis, screenToWorld(sx, sy), vpDragSeed);
    dragMoved = true;
    draw();
    return;
  }

  if (dragCorner >= 0) {
    const { w, h } = viewSize();
    applyCornerDrag(corners, dragCorner, screenToWorld(sx, sy), principalPoint(w, h));
    dragMoved = true;
    draw();
    return;
  }

  if (dragGizmoLayerId) {
    const wp = screenToWorld(sx, sy);
    const dx = wp.x - dragGizmoStart.x;
    const dy = wp.y - dragGizmoStart.y;
    const layer = layers.find((l) => l.id === dragGizmoLayerId);
    if (layer.type === "image") {
      layer.pos = { x: dragGizmoOrigin.x + dx, y: dragGizmoOrigin.y + dy };
    } else if (layer.type === "box") {
      // Reset corners to drag-start so edge lengths stay stable, then ask
      // cuboid.js to translate the box while keeping the VPs fixed (anchors
      // re-aim along rays from the new c0 to each unchanged VP).
      for (let i = 0; i < 8; i++) {
        corners[i] = { x: dragGizmoOrigin[i].x, y: dragGizmoOrigin[i].y };
      }
      translateBoxKeepingVPs(corners, dx, dy);
    }
    dragMoved = true;
    draw();
    return;
  }

  if (panning && panStart) {
    panX = panOrigin.x + (sx - panStart.x);
    panY = panOrigin.y + (sy - panStart.y);
    draw();
    return;
  }

  // Hover detection
  const vpHover = hitVP(sx, sy);
  const overCorner = !vpHover && hitCorner(sx, sy) >= 0;
  const next = vpHover || overCorner ? null : hitLayer(sx, sy);
  let needsRedraw = false;
  if (next !== hoveredLayerId) {
    hoveredLayerId = next;
    needsRedraw = true;
  }
  const nextVP = vpHover ? vpHover.axis : null;
  if (nextVP !== hoveredVPAxis) {
    hoveredVPAxis = nextVP;
    needsRedraw = true;
  }
  if (needsRedraw) draw();
  canvas.style.cursor = vpHover
    ? "grab"
    : overCorner
      ? "grab"
      : next
        ? "move"
        : "default";
});

canvas.addEventListener("pointerup", (e) => {
  activePointers.delete(e.pointerId);

  if (gesture) {
    if (activePointers.size >= 2) {
      // Still multi-touch (e.g. 3→2 fingers). Re-anchor so the remaining
      // fingers don't trigger a sudden jump.
      beginGesture();
      return;
    }
    gesture = null;
    if (activePointers.size === 1) {
      // Drop back to a single-finger pan from the remaining touch's spot.
      const [pos] = activePointers.values();
      panning = true;
      panStart = v(pos.x, pos.y);
      panOrigin = v(panX, panY);
    }
    return;
  }

  if (pendingPreSnap && dragMoved) commitPre(pendingPreSnap);
  pendingPreSnap = null;
  dragMoved = false;
  dragCorner = -1;
  dragGizmoLayerId = null;
  dragGizmoStart = null;
  dragGizmoOrigin = null;
  dragVPAxis = null;
  vpDragSeed = null;
  panning = false;
  panStart = null;
  canvas.style.cursor = "default";
});

canvas.addEventListener("pointercancel", (e) => {
  activePointers.delete(e.pointerId);
  if (gesture && activePointers.size < 2) {
    gesture = null;
    panning = false;
    panStart = null;
  }
  pendingPreSnap = null;
  dragMoved = false;
  dragCorner = -1;
  dragGizmoLayerId = null;
  dragVPAxis = null;
  vpDragSeed = null;
});

canvas.addEventListener("pointerleave", () => {
  if (hoveredLayerId) {
    hoveredLayerId = null;
    draw();
  }
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
    panX = sx - before.x * zoom;
    panY = sy - before.y * zoom;
    draw();
  },
  { passive: false },
);

spacingInput.addEventListener("input", () => {
  beginSliderEdit();
  spacingVal.textContent = spacingInput.value;
  draw();
});
spacingInput.addEventListener("change", endSliderEdit);

resetBtn.addEventListener("click", () => {
  commitPre(snapshotState());
  resetBox();
  draw();
});

toggleBtn.addEventListener("click", () => {
  toolbox.classList.toggle("collapsed");
  toggleBtn.textContent = toolbox.classList.contains("collapsed") ? "›" : "≡";
});

// Help modal: open via the ? button, close by clicking the close button, the
// backdrop, or pressing Escape. The data-close="1" marker covers both the
// backdrop and the × button so a single delegated listener handles both.
helpBtn.addEventListener("click", () => helpModal.hidden = false);
helpModal.addEventListener("click", (e) => {
  if (e.target instanceof HTMLElement && e.target.dataset.close === "1") {
    helpModal.hidden = true;
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !helpModal.hidden) helpModal.hidden = true;
});

uploadInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length) commitPre(snapshotState());
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const { w, h } = viewSize();
    const layer = createImageLayer(img, file.name, principalPoint(w, h), {
      w: w / zoom,
      h: h / zoom,
    });
    layers = [layer, ...layers]; // bottom = drawn first
    renderLayerList();
    draw();
  }
  uploadInput.value = "";
});

// ResizeObserver fires on any layout change to the canvas's flex parent
// (window resize, toolbox collapse/expand, etc.). The window-resize listener
// alone would miss the collapse since the viewport width doesn't change.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(resize).observe(canvas.parentElement);
} else {
  window.addEventListener("resize", resize);
}

// ----- Layer list UI -----

function renderLayerList() {
  layersList.innerHTML = "";
  // Show top→bottom (last in array = top visually = first in list)
  const display = [...layers].reverse();
  for (const layer of display) {
    const row = document.createElement("div");
    row.className = "layer" + (layer.visible ? "" : " hidden");
    row.dataset.id = layer.id;

    const head = document.createElement("div");
    head.className = "layer-head";

    let swatch = null;
    if (layer.type === "grid" || layer.type === "box" || layer.type === "vp-triangle") {
      swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.style.background = layer.color;
      swatch.title = "Click to change color";
      swatch.addEventListener("click", (e) => {
        e.stopPropagation();
        openHueLayerId = openHueLayerId === layer.id ? null : layer.id;
        renderLayerList();
      });
      head.appendChild(swatch);
    } else if (layer.type === "background") {
      // Background uses a native color picker rather than a hue slider, so
      // the user can also pick neutral / off-gamut shades (white, gray, etc.).
      const wrap = document.createElement("label");
      wrap.className = "swatch";
      wrap.style.background = layer.color;
      wrap.title = "Click to change background color";
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = layer.color;
      colorInput.className = "color-picker";
      colorInput.addEventListener("input", () => {
        beginSliderEdit();
        layers = updateLayer(layers, layer.id, { color: colorInput.value });
        wrap.style.background = colorInput.value;
        draw();
      });
      colorInput.addEventListener("change", endSliderEdit);
      wrap.appendChild(colorInput);
      head.appendChild(wrap);
    } else if (layer.type === "horizon") {
      // Static gradient indicator — color is derived from the two grid layers
      // so this swatch isn't interactive.
      const colA = gridLayerColor(layer.axes[0]);
      const colB = gridLayerColor(layer.axes[1]);
      const grad = document.createElement("span");
      grad.className = "swatch";
      grad.style.background = `linear-gradient(90deg, ${colA}, ${colB})`;
      grad.style.cursor = "default";
      head.appendChild(grad);
    }

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = layer.name;
    head.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "layer-actions";

    const up = button("↑", () => {
      commitPre(snapshotState());
      layers = moveLayer(layers, layer.id, +1);
      renderLayerList();
      draw();
    });
    const down = button("↓", () => {
      commitPre(snapshotState());
      layers = moveLayer(layers, layer.id, -1);
      renderLayerList();
      draw();
    });
    const vis = button(layer.visible ? "●" : "○", () => {
      commitPre(snapshotState());
      layers = updateLayer(layers, layer.id, { visible: !layer.visible });
      renderLayerList();
      draw();
    });
    up.title = "Move up";
    down.title = "Move down";
    vis.title = layer.visible ? "Hide" : "Show";
    actions.append(up, down, vis);

    if (layer.type === "image") {
      const del = button("×", () => {
        commitPre(snapshotState());
        layers = removeLayer(layers, layer.id);
        renderLayerList();
        draw();
      });
      del.title = "Remove";
      actions.appendChild(del);
    }

    head.appendChild(actions);
    row.appendChild(head);

    const opRow = document.createElement("div");
    opRow.className = "opacity-row";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.01";
    slider.value = String(layer.opacity);
    slider.addEventListener("input", () => {
      beginSliderEdit();
      layers = updateLayer(layers, layer.id, { opacity: parseFloat(slider.value) });
      const lbl = opRow.querySelector("span");
      if (lbl) lbl.textContent = Math.round(parseFloat(slider.value) * 100) + "%";
      draw();
    });
    slider.addEventListener("change", endSliderEdit);
    const opLbl = document.createElement("span");
    opLbl.textContent = Math.round(layer.opacity * 100) + "%";
    opRow.append(slider, opLbl);
    row.appendChild(opRow);

    // Per-grid VP controls: angle and 1/distance from c0. invDist=0 sends the
    // VP to infinity, collapsing perspective along that axis to orthographic.
    if (layer.type === "grid") {
      const polar = vpPolar(snapshotVPs()?.[`v${layer.axis}`], corners[0]);
      const angleRow = makeVPSlider({
        id: `vp-angle-${layer.axis}`,
        label: "Angle",
        min: -180,
        max: 180,
        step: 1,
        value: (polar.angle * 180) / Math.PI,
        fmt: (v) => `${Math.round(v)}°`,
        onInput: (v) => {
          beginSliderEdit();
          const current = vpPolar(snapshotVPs()?.[`v${layer.axis}`], corners[0]);
          setVPPolar(corners, layer.axis, (v * Math.PI) / 180, current.invDist);
          draw();
        },
      });
      const distRow = makeVPSlider({
        id: `vp-invdist-${layer.axis}`,
        label: "1 / dist",
        min: 0,
        max: 0.01,
        step: 0.00002,
        value: polar.invDist,
        fmt: (v) => v < 1e-6 ? "∞" : Math.round(1 / v) + "px",
        onInput: (v) => {
          beginSliderEdit();
          const current = vpPolar(snapshotVPs()?.[`v${layer.axis}`], corners[0]);
          setVPPolar(corners, layer.axis, current.angle, v);
          draw();
        },
      });
      row.appendChild(angleRow);
      row.appendChild(distRow);
    }

    if (swatch && openHueLayerId === layer.id) {
      const hueRow = document.createElement("div");
      hueRow.className = "hue-row";
      const hueSlider = document.createElement("input");
      hueSlider.type = "range";
      hueSlider.min = "0";
      hueSlider.max = "360";
      hueSlider.value = String(layer.hue ?? 0);
      hueSlider.className = "hue-slider";
      hueSlider.addEventListener("input", () => {
        beginSliderEdit();
        const hue = parseInt(hueSlider.value, 10);
        const color = hueToColor(hue);
        layers = updateLayer(layers, layer.id, { hue, color });
        swatch.style.background = color;
        // Refresh dependent horizon-layer swatches if this is a grid color.
        if (layer.type === "grid") {
          for (const row of layersList.querySelectorAll(".layer")) {
            const id = row.dataset.id;
            const l = layers.find((x) => x.id === id);
            if (l?.type === "horizon") {
              const sw = row.querySelector(".swatch");
              if (sw) {
                const cA = gridLayerColor(l.axes[0]);
                const cB = gridLayerColor(l.axes[1]);
                sw.style.background = `linear-gradient(90deg, ${cA}, ${cB})`;
              }
            }
          }
        }
        draw();
      });
      hueSlider.addEventListener("change", endSliderEdit);
      hueRow.appendChild(hueSlider);
      row.appendChild(hueRow);
    }

    layersList.appendChild(row);
  }
}

function makeVPSlider({ id, label, min, max, step, value, fmt, onInput }) {
  const row = document.createElement("div");
  row.className = "vp-slider-row";
  const lbl = document.createElement("span");
  lbl.className = "vp-slider-label";
  lbl.textContent = label;
  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = id;
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  const valLbl = document.createElement("span");
  valLbl.className = "vp-slider-val";
  valLbl.textContent = fmt(value);
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    valLbl.textContent = fmt(v);
    onInput(v);
  });
  slider.addEventListener("change", endSliderEdit);
  row.append(lbl, slider, valLbl);
  return row;
}

/**
 * Push current VP polar coords into the toolbox sliders. Called after every
 * draw so the sliders track direct canvas manipulations (VP drag, anchor
 * drag, box translation). Skips a slider while it's being actively interacted
 * with so we don't yank the thumb out from under the user.
 */
function syncVPSliders() {
  const vps = snapshotVPs();
  if (!vps) return;
  const active = document.activeElement;
  for (const axis of ["x", "y", "z"]) {
    const polar = vpPolar(vps[`v${axis}`], corners[0]);
    const angleEl = document.getElementById(`vp-angle-${axis}`);
    if (angleEl && angleEl !== active) {
      angleEl.value = String((polar.angle * 180) / Math.PI);
      const val = angleEl.parentElement?.querySelector(".vp-slider-val");
      if (val) val.textContent = `${Math.round((polar.angle * 180) / Math.PI)}°`;
    }
    const distEl = document.getElementById(`vp-invdist-${axis}`);
    if (distEl && distEl !== active) {
      distEl.value = String(polar.invDist);
      const val = distEl.parentElement?.querySelector(".vp-slider-val");
      if (val) val.textContent = polar.invDist < 1e-6 ? "∞" : Math.round(1 / polar.invDist) + "px";
    }
  }
}

function button(text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Undo / redo keyboard. Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z (or Y) = redo.
 * Skipped if the user is typing in a text input. Range/color inputs are still
 * eligible because the sliders themselves don't capture keypresses we care
 * about.
 */
window.addEventListener("keydown", (e) => {
  const inText = e.target instanceof HTMLElement &&
    (e.target.tagName === "INPUT" && /^(text|search|email|number|url|password)$/i.test(e.target.type) ||
      e.target.tagName === "TEXTAREA" ||
      e.target.isContentEditable);
  if (inText) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    // Flush any in-flight slider commit so undo lands on a stable boundary.
    endSliderEdit();
    undo(snapshotState(), restoreState);
  } else if ((key === "z" && e.shiftKey) || key === "y") {
    e.preventDefault();
    endSliderEdit();
    redo(snapshotState(), restoreState);
  }
});

renderLayerList();
resize();
clearHistory();
