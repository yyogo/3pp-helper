import { clipSegmentToRect, isFinitePoint } from "./geom.js";

/**
 * Draw a 360° grid of perspective lines through a single vanishing point.
 * Lines are clipped to `rect` (a world-space viewport rectangle) so panning
 * doesn't reveal grid endpoints at fixed world-space distances.
 *
 * The fan is *anchored* at `anchor` (typically c0): one ray of the fan
 * always passes through `anchor`, so the box edges meeting at c0 sit on
 * grid lines.
 *
 * For finite VPs: `divisions` rays through the VP, the 0th ray pointing at
 * the anchor and the rest evenly spaced around it.
 * For VPs at infinity: parallel lines in the VP direction, one of which
 * passes through the anchor.
 */
export function drawAxisGrid(ctx, vp, divisions, color, lineScale, rect, anchor) {
  if (!vp || !rect) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineScale;

  const n = Math.max(1, divisions);
  if (vp.finite && isFinitePoint(vp.p)) {
    const baseAng = anchor
      ? Math.atan2(anchor.y - vp.p.y, anchor.x - vp.p.x)
      : 0;
    for (let i = 0; i < n; i++) {
      const ang = baseAng + (i / n) * Math.PI; // opposite angles share a line
      drawClippedLine(ctx, vp.p, Math.cos(ang), Math.sin(ang), rect);
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
