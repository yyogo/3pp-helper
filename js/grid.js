import { clipSegmentToRect, isFinitePoint, lineIntersect } from "./geom.js";

/**
 * Draw a grid of perspective lines through a single vanishing point.
 *
 * The fan is *anchored* at `anchor` (typically c0): one ray of the fan
 * always passes through `anchor`, so the box edges meeting at c0 sit on
 * grid lines.
 *
 * When `triangle` (the three VP positions) is provided and `vp` is a finite
 * vertex of it, the fan is clipped to the cone of vision — only rays inside
 * the triangle are drawn, each stopping at the opposite triangle side.
 * Outside that cone the perspective is hyperbolic, so drawing rays there
 * would be visually misleading.
 *
 * When `triangle` is null (any VP at infinity), falls back to a 360° fan
 * clipped to the world-space `rect`, matching the pre-cone-of-vision look.
 *
 * For VPs at infinity: parallel lines in the VP direction, one of which
 * passes through the anchor.
 */
export function drawAxisGrid(ctx, vp, divisions, color, lineScale, rect, anchor, triangle) {
  if (!vp || !rect) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineScale;

  const n = Math.max(1, divisions);
  if (vp.finite && isFinitePoint(vp.p)) {
    if (triangle) {
      drawTriangleClippedFan(ctx, vp, n, anchor, triangle, rect);
    } else {
      const baseAng = anchor
        ? Math.atan2(anchor.y - vp.p.y, anchor.x - vp.p.x)
        : 0;
      for (let i = 0; i < n; i++) {
        const ang = baseAng + (i / n) * Math.PI; // opposite angles share a line
        drawClippedLine(ctx, vp.p, Math.cos(ang), Math.sin(ang), rect);
      }
    }
  } else if (!vp.finite) {
    const d = vp.dir;
    const perp = { x: -d.y, y: d.x };
    const cx = (rect.x0 + rect.x1) / 2;
    const cy = (rect.y0 + rect.y1) / 2;
    const span = Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0);
    const step = span / n;
    // Shift the parallel family so one line passes through the anchor.
    const anchorOffset = anchor
      ? (anchor.x - cx) * perp.x + (anchor.y - cy) * perp.y
      : 0;
    // Number of steps each side of the anchor needed to cover the rect.
    const half = Math.ceil((span / 2 + Math.abs(anchorOffset)) / step);
    for (let i = -half; i <= half; i++) {
      const t = anchorOffset + i * step;
      const origin = { x: cx + perp.x * t, y: cy + perp.y * t };
      drawClippedLine(ctx, origin, d.x, d.y, rect);
    }
  }
  ctx.restore();
}

/**
 * Fan of perspective rays from `vp` (a triangle vertex) toward the opposite
 * side, anchored at `anchor`. Step size is `coneAngle / divisions`, so the
 * slider keeps roughly its old "density" feel when zoomed into the cone.
 */
function drawTriangleClippedFan(ctx, vp, divisions, anchor, triangle, rect) {
  // The two non-vp vertices of the triangle.
  let A = null, B = null;
  for (const p of triangle) {
    if (Math.abs(p.x - vp.p.x) < 1e-6 && Math.abs(p.y - vp.p.y) < 1e-6) continue;
    if (!A) A = p; else B = p;
  }
  if (!A || !B) return;

  const angA = Math.atan2(A.y - vp.p.y, A.x - vp.p.x);
  const angB = Math.atan2(B.y - vp.p.y, B.x - vp.p.x);
  const baseAng = anchor
    ? Math.atan2(anchor.y - vp.p.y, anchor.x - vp.p.x)
    : (angA + angB) / 2;

  // Offsets of A and B from baseAng, normalized to (-π, π].
  const norm = (a) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  };
  const offA = norm(angA - baseAng);
  const offB = norm(angB - baseAng);
  const lo = Math.min(offA, offB);
  const hi = Math.max(offA, offB);
  // Anchor must straddle the cone (lo < 0 < hi). Otherwise the anchor sits
  // outside the cone-of-vision sector — nothing meaningful to draw.
  if (lo > 1e-6 || hi < -1e-6) return;

  const span = hi - lo;
  const step = span / divisions;
  if (!(step > 1e-9)) return;

  // Integer k indexes rays at baseAng + k*step. Skip the two edge rays (which
  // coincide with the triangle's other sides — already drawn by the VP
  // triangle layer).
  const eps = step * 0.05;
  const kMin = Math.ceil((lo + eps) / step);
  const kMax = Math.floor((hi - eps) / step);
  for (let k = kMin; k <= kMax; k++) {
    drawRayToOppositeSide(ctx, vp.p, baseAng + k * step, A, B, rect);
  }
}

function drawRayToOppositeSide(ctx, vp, ang, A, B, rect) {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const hit = lineIntersect(vp, { x: vp.x + dx, y: vp.y + dy }, A, B);
  if (!hit || !isFinitePoint(hit)) return;
  const clipped = clipSegmentToRect(vp, hit, rect.x0, rect.y0, rect.x1, rect.y1);
  if (!clipped) return;
  ctx.beginPath();
  ctx.moveTo(clipped[0].x, clipped[0].y);
  ctx.lineTo(clipped[1].x, clipped[1].y);
  ctx.stroke();
}

/** Stroke an infinite line through `p` in direction (dx,dy), clipped to rect. */
function drawClippedLine(ctx, p, dx, dy, rect) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return;
  const ux = dx / len;
  const uy = dy / len;
  // Segment must be long enough to reach past the rect even when `p` (the VP)
  // is far outside it, so use max(rect diagonal, distance from p to rect).
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const diag = Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0);
  const distToRect = Math.hypot(p.x - cx, p.y - cy);
  const big = Math.max(diag, distToRect) * 4;
  const clipped = clipSegmentToRect(
    { x: p.x - ux * big, y: p.y - uy * big },
    { x: p.x + ux * big, y: p.y + uy * big },
    rect.x0,
    rect.y0,
    rect.x1,
    rect.y1,
  );
  if (!clipped) return;
  ctx.beginPath();
  ctx.moveTo(clipped[0].x, clipped[0].y);
  ctx.lineTo(clipped[1].x, clipped[1].y);
  ctx.stroke();
}

/** VP marker on canvas. `scale` is world-units-per-screen-pixel for sizing. */
export function drawVP(ctx, vp, label, color, scale = 1, active = false) {
  if (!vp) return;
  ctx.save();
  if (vp.finite && isFinitePoint(vp.p)) {
    const { x, y } = vp.p;
    if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) {
      ctx.restore();
      return;
    }
    const r = (active ? 9 : 6) * scale;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (active) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 * scale;
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.font = `${11 * scale}px system-ui, sans-serif`;
    ctx.fillText(label, x + 10 * scale, y - 10 * scale);
  }
  ctx.restore();
}
