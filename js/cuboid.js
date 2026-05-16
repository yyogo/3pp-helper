import {
  add,
  isFinitePoint,
  lerp,
  lineIntersect,
  sub,
  v,
  vanishingPointFromEdges,
  vpFinite,
} from "./geom.js";

/** Corner index = x | (y<<1) | (z<<2) */
export const BOX_EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export const ANCHOR_CORNERS = [0, 1, 2, 4];
export const DERIVED_CORNERS = [3, 5, 6, 7];

const FACES = [
  [0, 1, 3, 2],
  [4, 5, 7, 6],
  [0, 2, 6, 4],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
];

const AXIS_OF_ANCHOR = { 1: "vx", 2: "vy", 4: "vz" };
const ANCHOR_OF_AXIS = { vx: 1, vy: 2, vz: 4 };

/**
 * The three vanishing points are persistent module state. They're updated by
 * three different interactions:
 *   - **VP drag**: the user moves a VP directly → assign it.
 *   - **Anchor drag (c1/c2/c4)**: the ray c0→anchor rotates → project the
 *     corresponding VP onto the new ray, preserving its along-ray distance.
 *     The other two VPs are unaffected.
 *   - **c0 drag**: all three rays rotate → project all three VPs onto their
 *     new rays.
 *   - **Derived-corner drag**: re-derive the VPs that the dragged corner
 *     touches from its new position; leave the others alone.
 *
 * Treating VPs as state (rather than re-deriving them from every edge each
 * frame) means an anchor drag along its ray only resizes the box without
 * shifting the other VPs — which is what "the anchors aren't constrained"
 * actually requires.
 */
let stableVPs = null;

function copyVP(vp) {
  if (!vp) return null;
  if (vp.finite) return { finite: true, p: { x: vp.p.x, y: vp.p.y } };
  return { finite: false, dir: { x: vp.dir.x, y: vp.dir.y } };
}

function snapshotVPs() {
  if (!stableVPs) return null;
  return { vx: copyVP(stableVPs.vx), vy: copyVP(stableVPs.vy), vz: copyVP(stableVPs.vz) };
}

function restoreVPs(snap) {
  stableVPs = snap
    ? { vx: copyVP(snap.vx), vy: copyVP(snap.vy), vz: copyVP(snap.vz) }
    : null;
}

function vpFrom(a1, a2, b1, b2) {
  return vanishingPointFromEdges(a1, a2, b1, b2);
}

/** Edge-derived VPs (used only for initial seeding, not steady-state). */
function edgeVPs(corners) {
  return {
    vx: vpFrom(corners[0], corners[1], corners[2], corners[3]),
    vy: vpFrom(corners[0], corners[2], corners[1], corners[3]),
    vz: vpFrom(corners[0], corners[4], corners[1], corners[5]),
  };
}

/**
 * Project a VP onto the line through c0 in direction `dir`. Distance from c0
 * along the ray is preserved; the perpendicular component is discarded so the
 * VP lies on the new ray exactly.
 */
function projectOntoRay(vp, c0, dir) {
  if (!vp) return null;
  const dlen2 = dir.x * dir.x + dir.y * dir.y;
  if (dlen2 < 1e-9) return vp;
  if (!vp.finite) {
    const len = Math.sqrt(dlen2);
    return { finite: false, dir: { x: dir.x / len, y: dir.y / len } };
  }
  const t = ((vp.p.x - c0.x) * dir.x + (vp.p.y - c0.y) * dir.y) / dlen2;
  if (!Number.isFinite(t) || Math.abs(t) < 1e-9) return vp;
  return vpFinite({ x: c0.x + dir.x * t, y: c0.y + dir.y * t });
}

/** Read-only accessor for app.js (drawing, hit-testing). */
export function estimateVanishingPoints(corners) {
  if (stableVPs?.vx && stableVPs?.vy && stableVPs?.vz) {
    return { vx: stableVPs.vx, vy: stableVPs.vy, vz: stableVPs.vz };
  }
  const ev = edgeVPs(corners);
  stableVPs = { vx: ev.vx, vy: ev.vy, vz: ev.vz };
  return ev;
}

function rayDir(p, vp) {
  if (!vp) return null;
  return vp.finite ? sub(vp.p, p) : { x: vp.dir.x, y: vp.dir.y };
}

export function cornerFromRays(a, vpA, b, vpB) {
  const da = rayDir(a, vpA);
  const db = rayDir(b, vpB);
  if (!da || !db) return null;
  return lineIntersect(a, add(a, da), b, add(b, db));
}

export function rebuildDerivedCorners(corners, vx, vy, vz) {
  if (!vx || !vy || !vz) return;
  const c3 = cornerFromRays(corners[2], vx, corners[1], vy);
  const c5 = cornerFromRays(corners[4], vx, corners[1], vz);
  const c6 = cornerFromRays(corners[4], vy, corners[2], vz);
  if (isFinitePoint(c3)) corners[3] = c3;
  if (isFinitePoint(c5)) corners[5] = c5;
  if (isFinitePoint(c6)) corners[6] = c6;
  const c7 = cornerFromRays(corners[6], vx, corners[5], vy);
  if (isFinitePoint(c7)) corners[7] = c7;
}

function rebuildDerivedExcept(corners, vx, vy, vz, skip) {
  const pin = skip >= 0 ? { x: corners[skip].x, y: corners[skip].y } : null;
  rebuildDerivedCorners(corners, vx, vy, vz);
  if (pin) corners[skip] = pin;
}

/**
 * Sync after an anchor moves: project the affected VPs onto their new rays
 * (keeping the others untouched), then rebuild derived corners.
 *
 * `draggedIdx` is the corner index that just moved. -1 means "all rays might
 * have changed" — used after a c0 move or a wholesale corner reset.
 */
function syncFromAnchorMove(corners, draggedIdx) {
  if (!stableVPs) {
    stableVPs = edgeVPs(corners);
  }
  const c0 = corners[0];
  const updateAll = draggedIdx === 0 || draggedIdx < 0;
  for (const [anchorIdxStr, axis] of Object.entries(AXIS_OF_ANCHOR)) {
    const anchorIdx = Number(anchorIdxStr);
    if (updateAll || draggedIdx === anchorIdx) {
      stableVPs[axis] = projectOntoRay(stableVPs[axis], c0, sub(corners[anchorIdx], c0));
    }
  }
  rebuildDerivedCorners(corners, stableVPs.vx, stableVPs.vy, stableVPs.vz);
}

/**
 * Sync after a derived corner moves: re-derive the VPs that the dragged
 * corner participates in, leaving the others as they were. The dragged corner
 * itself is preserved (we don't snap it back during the rebuild).
 */
function syncFromDerivedMove(corners, index, p) {
  if (!stableVPs) stableVPs = edgeVPs(corners);
  const c = corners;
  const partial = {
    3: { vx: vpFrom(c[0], c[1], c[2], p), vy: vpFrom(c[0], c[2], c[1], p) },
    5: { vx: vpFrom(c[0], c[1], c[4], p), vz: vpFrom(c[0], c[4], c[1], p) },
    6: { vy: vpFrom(c[0], c[2], c[4], p), vz: vpFrom(c[0], c[4], c[2], p) },
    7: {
      vx: vpFrom(c[0], c[1], c[6], p),
      vy: vpFrom(c[0], c[2], c[5], p),
      vz: vpFrom(c[0], c[4], c[3], p),
    },
  }[index];
  if (partial) {
    for (const k of ["vx", "vy", "vz"]) {
      if (partial[k]) stableVPs[k] = partial[k];
    }
  }
  rebuildDerivedExcept(corners, stableVPs.vx, stableVPs.vy, stableVPs.vz, index);
}

/** Used at init / reset only — rebuild from scratch using edge-derived VPs. */
export function syncCuboid(corners) {
  stableVPs = edgeVPs(corners);
  rebuildDerivedCorners(corners, stableVPs.vx, stableVPs.vy, stableVPs.vz);
  return { ...stableVPs };
}

function applyVPDragRaw(corners, axis, newVpPos, seedVPs) {
  const anchorIdx = ANCHOR_OF_AXIS[`v${axis}`];
  const vpKey = `v${axis}`;
  if (anchorIdx == null) return false;

  const c0 = corners[0];
  const oldAnchor = corners[anchorIdx];
  const oldLen = Math.hypot(oldAnchor.x - c0.x, oldAnchor.y - c0.y);
  const ddx = newVpPos.x - c0.x;
  const ddy = newVpPos.y - c0.y;
  const dlen = Math.hypot(ddx, ddy);
  if (dlen < 1e-3 || oldLen < 1e-3) return false;

  corners[anchorIdx] = {
    x: c0.x + (ddx / dlen) * oldLen,
    y: c0.y + (ddy / dlen) * oldLen,
  };

  const newVPs = { ...seedVPs, [vpKey]: vpFinite(newVpPos) };
  rebuildDerivedCorners(corners, newVPs.vx, newVPs.vy, newVPs.vz);
  return newVPs;
}

/**
 * Drag a VP directly. The corresponding anchor rotates around c0 (preserving
 * edge length); derived corners are rebuilt from the user-chosen VPs. Drag
 * distance is binary-search-clamped so the box stays convex.
 */
export function applyVPDrag(corners, axis, newVpPos, seedVPs) {
  const vpKey = `v${axis}`;
  const oldVp = seedVPs?.[vpKey];
  const oldPos = oldVp?.finite
    ? { x: oldVp.p.x, y: oldVp.p.y }
    : { x: corners[0].x, y: corners[0].y };
  const snapC = snapshot(corners);
  const snapV = snapshotVPs();

  let acceptedVPs = null;
  const trial = (t) => {
    restore(corners, snapC);
    restoreVPs(snapV);
    const p = {
      x: oldPos.x + (newVpPos.x - oldPos.x) * t,
      y: oldPos.y + (newVpPos.y - oldPos.y) * t,
    };
    const res = applyVPDragRaw(corners, axis, p, seedVPs);
    if (res) acceptedVPs = res;
    return res;
  };

  if (trial(1) && boxConfigValid(corners)) {
    stableVPs = { vx: acceptedVPs.vx, vy: acceptedVPs.vy, vz: acceptedVPs.vz };
    return;
  }

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const okMid = trial(mid);
    if (okMid && boxConfigValid(corners)) lo = mid;
    else hi = mid;
  }
  if (lo > 1e-4) {
    trial(lo);
    if (acceptedVPs) {
      stableVPs = { vx: acceptedVPs.vx, vy: acceptedVPs.vy, vz: acceptedVPs.vz };
    }
  } else {
    restore(corners, snapC);
    restoreVPs(snapV);
  }
}

function segmentsCross(a, b, c, d) {
  const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function boxConfigValid(corners) {
  for (const [a, b, c, d] of FACES) {
    if (!segmentsCross(corners[a], corners[c], corners[b], corners[d])) {
      return false;
    }
  }
  return true;
}

function snapshot(corners) {
  return corners.map((p) => ({ x: p.x, y: p.y }));
}

function restore(corners, snap) {
  for (let i = 0; i < 8; i++) corners[i] = { x: snap[i].x, y: snap[i].y };
}

function applyAt(corners, index, from, pos, t) {
  const newPos = {
    x: from.x + (pos.x - from.x) * t,
    y: from.y + (pos.y - from.y) * t,
  };
  corners[index] = newPos;
  if (ANCHOR_CORNERS.includes(index)) {
    syncFromAnchorMove(corners, index);
  } else {
    syncFromDerivedMove(corners, index, newPos);
    corners[index] = newPos;
  }
}

export function applyCornerDrag(corners, index, pos) {
  const snapC = snapshot(corners);
  const snapV = snapshotVPs();
  const from = { x: snapC[index].x, y: snapC[index].y };

  const trial = (t) => {
    restore(corners, snapC);
    restoreVPs(snapV);
    applyAt(corners, index, from, pos, t);
  };

  trial(1);
  if (boxConfigValid(corners)) return;

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    trial(mid);
    if (boxConfigValid(corners)) lo = mid;
    else hi = mid;
  }
  if (lo > 1e-4) {
    trial(lo);
    if (!boxConfigValid(corners)) {
      restore(corners, snapC);
      restoreVPs(snapV);
    }
  } else {
    restore(corners, snapC);
    restoreVPs(snapV);
  }
}

/**
 * Build a 3-point perspective cube by picking three off-screen vanishing
 * points and foreshortening each axis by `t`. The resulting 8 corners have
 * edges that converge at those VPs, so the initial state is a real
 * perspective cube — not a degenerate placeholder.
 */
export function defaultCorners(cx, cy, s) {
  const c0 = v(cx, cy);
  const Vx = v(cx + 16 * s, cy + 2.5 * s);
  const Vy = v(cx - 15 * s, cy + 2.5 * s);
  const Vz = v(cx + 0.8 * s, cy - 15 * s);
  const t = 0.11;
  const c1 = lerp(c0, Vx, t);
  const c2 = lerp(c0, Vy, t);
  const c4 = lerp(c0, Vz, t);
  const c3 = lineIntersect(c2, Vx, c1, Vy);
  const c5 = lineIntersect(c4, Vx, c1, Vz);
  const c6 = lineIntersect(c4, Vy, c2, Vz);
  const c7 = lineIntersect(c6, Vx, c5, Vy);
  return [c0, c1, c2, c3 ?? c0, c4, c5 ?? c0, c6 ?? c0, c7 ?? c0];
}

/**
 * Translate the box while keeping the VPs fixed in world space.
 *
 * Each anchor sits at a constant *foreshortening fraction* `f_k` along the
 * segment `c0 → VP_k` (where `f_k = |c_anchor - c0| / |VP - c0|` at drag
 * start). After translating c0 to a new image position the anchor is placed
 * at `newC0 + f_k * (VP - newC0)`. As c0 moves toward a VP, `|VP - newC0|`
 * shrinks and so does the apparent edge length — matching real perspective
 * foreshortening (camera looking down that axis sees the edge collapse).
 *
 * VPs at infinity preserve their absolute edge length (parallel projection
 * has no foreshortening). If `boxConfigValid` fails (e.g. the box collapses
 * past geometric usability) the translation is binary-search-clamped back to
 * the largest valid fraction.
 *
 * Pass the *cumulative* delta from drag-start each frame (the caller should
 * restore corners from a snapshot first so the fractions stay constant).
 */
export function translateBoxKeepingVPs(corners, dx, dy) {
  if (!stableVPs) {
    for (let i = 0; i < 8; i++) {
      corners[i] = { x: corners[i].x + dx, y: corners[i].y + dy };
    }
    return;
  }
  const snap = snapshot(corners);
  const anchors = [1, 2, 4];
  const axes = ["vx", "vy", "vz"];
  // fractions[k]: lerp ratio for finite VPs; infLens[k]: absolute edge length
  // for VPs at infinity (parallel projection — no perspective shrink).
  const fractions = [];
  const infLens = [];
  for (let k = 0; k < 3; k++) {
    const vp = stableVPs[axes[k]];
    const anchorIdx = anchors[k];
    if (vp?.finite) {
      const denom = Math.hypot(vp.p.x - snap[0].x, vp.p.y - snap[0].y);
      const lenAnchor = Math.hypot(snap[anchorIdx].x - snap[0].x, snap[anchorIdx].y - snap[0].y);
      fractions.push(denom > 1e-9 ? lenAnchor / denom : null);
      infLens.push(null);
    } else {
      fractions.push(null);
      infLens.push(Math.hypot(snap[anchorIdx].x - snap[0].x, snap[anchorIdx].y - snap[0].y));
    }
  }

  const apply = (t) => {
    restore(corners, snap);
    const newC0 = { x: snap[0].x + dx * t, y: snap[0].y + dy * t };
    corners[0] = newC0;
    for (let k = 0; k < 3; k++) {
      const vp = stableVPs[axes[k]];
      if (!vp) continue;
      if (vp.finite && fractions[k] != null) {
        corners[anchors[k]] = {
          x: newC0.x + (vp.p.x - newC0.x) * fractions[k],
          y: newC0.y + (vp.p.y - newC0.y) * fractions[k],
        };
      } else if (!vp.finite) {
        const len = Math.hypot(vp.dir.x, vp.dir.y);
        if (len < 1e-9) continue;
        corners[anchors[k]] = {
          x: newC0.x + (vp.dir.x / len) * infLens[k],
          y: newC0.y + (vp.dir.y / len) * infLens[k],
        };
      }
    }
    rebuildDerivedCorners(corners, stableVPs.vx, stableVPs.vy, stableVPs.vz);
    return boxConfigValid(corners);
  };

  if (apply(1)) return;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (apply(mid)) lo = mid;
    else hi = mid;
  }
  if (lo > 1e-4) apply(lo);
  else restore(corners, snap);
}

/** Reset the persistent VP state. Call from resetBox before syncing. */
export function resetVPSolver() {
  stableVPs = null;
}

// No-op kept for backward compat with earlier solver-based callers.
export function commitVPSolverSeed() {}
