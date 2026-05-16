/** @typedef {{ x: number, y: number }} Vec2 */

/**
 * @param {number} x
 * @param {number} y
 * @returns {Vec2}
 */
export function v(x, y) {
  return { x, y };
}

export function add(a, b) {
  return v(a.x + b.x, a.y + b.y);
}

export function sub(a, b) {
  return v(a.x - b.x, a.y - b.y);
}

export function scale(a, s) {
  return v(a.x * s, a.y * s);
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

export function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

export function len(a) {
  return Math.hypot(a.x, a.y);
}

export function dist(a, b) {
  return len(sub(a, b));
}

export function normalize(a) {
  const l = len(a);
  if (l < 1e-12) return v(1, 0);
  return scale(a, 1 / l);
}

export function midpoint(a, b) {
  return scale(add(a, b), 0.5);
}

export function lerp(a, b, t) {
  return add(a, scale(sub(b, a), t));
}

/**
 * Intersection of infinite lines AB and CD.
 * @returns {Vec2 | null}
 */
export function lineIntersect(a, b, c, d) {
  const r = sub(b, a);
  const s = sub(d, c);
  const rxs = cross(r, s);
  if (Math.abs(rxs) < 1e-10) return null;
  const t = cross(sub(c, a), s) / rxs;
  return add(a, scale(r, t));
}

/**
 * @param {Vec2} p
 * @param {Vec2} a
 * @param {Vec2} b
 */
export function projectOnSegment(p, a, b) {
  const ab = sub(b, a);
  const t = dot(sub(p, a), ab) / (dot(ab, ab) + 1e-12);
  return Math.max(0, Math.min(1, t));
}

/**
 * Point on ray from `origin` toward `through` at parameter t (Euclidean along image line).
 * @param {Vec2} origin
 * @param {Vec2} through
 * @param {number} t
 */
export function alongRay(origin, through, t) {
  return add(origin, scale(sub(through, origin), t));
}

/**
 * @param {Vec2 | null | undefined} p
 * @returns {p is Vec2}
 */
export function isFinitePoint(p) {
  return p != null && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * Average of finite points; ignores nulls.
 * @param {(Vec2 | null | undefined)[]} pts
 * @returns {Vec2 | null}
 */
export function averagePoints(pts) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of pts) {
    if (!isFinitePoint(p)) continue;
    sx += p.x;
    sy += p.y;
    n++;
  }
  if (n === 0) return null;
  return v(sx / n, sy / n);
}

/**
 * @typedef {{ finite: true, p: Vec2 } | { finite: false, dir: Vec2 }} VanishingPoint
 */

/**
 * @param {Vec2} p
 * @returns {VanishingPoint}
 */
export function vpFinite(p) {
  return { finite: true, p };
}

/**
 * @param {Vec2} dir normalized direction
 * @returns {VanishingPoint}
 */
export function vpInfinite(dir) {
  return { finite: false, dir: normalize(dir) };
}

/**
 * Build VP from two parallel edge segments in 3D (image lines).
 * @returns {VanishingPoint | null}
 */
export function vanishingPointFromEdges(a1, a2, b1, b2) {
  const p = lineIntersect(a1, a2, b1, b2);
  if (isFinitePoint(p)) {
    const maxExt = 1e7;
    if (
      Math.abs(p.x) > maxExt ||
      Math.abs(p.y) > maxExt ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y)
    ) {
      const dir = normalize(sub(a2, a1));
      return vpInfinite(dir);
    }
    return vpFinite(p);
  }
  const dir = normalize(sub(a2, a1));
  return vpInfinite(dir);
}

/**
 * @param {VanishingPoint} vp
 * @param {Vec2} a
 * @param {Vec2} b
 * @returns {Vec2 | null}
 */
export function lineMeetVP(vp, a, b) {
  if (vp.finite) return lineIntersect(a, b, vp.p, add(vp.p, sub(b, a)));
  const dir = vp.dir;
  const edge = normalize(sub(b, a));
  if (Math.abs(cross(dir, edge)) < 1e-6) return null;
  return lineIntersect(a, b, a, add(a, dir));
}

/**
 * Intersection of line (a,b) with line through vp in direction of c-d.
 * @param {VanishingPoint} vp
 * @param {Vec2} a
 * @param {Vec2} b
 * @param {Vec2} c
 * @param {Vec2} d
 */
export function intersectEdgeWithVP(vp, a, b, c, d) {
  if (vp.finite) {
    return lineIntersect(a, b, vp.p, add(vp.p, sub(c, d)));
  }
  const p = lineIntersect(a, b, c, add(c, vp.dir));
  return p;
}

/**
 * @param {VanishingPoint} vp
 * @param {Vec2} from
 * @param {Vec2} toward
 */
export function rayFromVP(vp, from, toward) {
  if (vp.finite) return lineIntersect(from, toward, vp.p, add(vp.p, sub(toward, from)));
  return lineIntersect(from, toward, from, add(from, vp.dir));
}

/**
 * Liang-Barsky segment clip to axis-aligned rect [x0,y0]-[x1,y1].
 * Returns null if the segment is entirely outside, else clipped endpoints.
 */
export function clipSegmentToRect(p0, p1, x0, y0, x1, y1) {
  let t0 = 0;
  let t1 = 1;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const tests = [
    [-dx, p0.x - x0],
    [dx, x1 - p0.x],
    [-dy, p0.y - y0],
    [dy, y1 - p0.y],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  if (t0 > t1) return null;
  return [
    { x: p0.x + t0 * dx, y: p0.y + t0 * dy },
    { x: p0.x + t1 * dx, y: p0.y + t1 * dy },
  ];
}

/**
 * Clip line through p0-p1 to a large axis-aligned rect around center.
 */
export function clipLineToRect(p0, p1, cx, cy, half) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const left = cx - half;
  const right = cx + half;
  const top = cy - half;
  const bottom = cy + half;
  const pts = [];

  if (Math.abs(dx) > 1e-9) {
    for (const X of [left, right]) {
      const t = (X - p0.x) / dx;
      const Y = p0.y + t * dy;
      if (Y >= top && Y <= bottom) pts.push(v(X, Y));
    }
  }
  if (Math.abs(dy) > 1e-9) {
    for (const Y of [top, bottom]) {
      const t = (Y - p0.y) / dy;
      const X = p0.x + t * dx;
      if (X >= left && X <= right) pts.push(v(X, Y));
    }
  }
  if (pts.length < 2) return [p0, p1];
  return [pts[0], pts[1]];
}

/**
 * Divide segment a-b into n equal steps (image-space lerp for UI spacing).
 * @returns {Vec2[]}
 */
export function divideSegment(a, b, divisions) {
  const n = Math.max(1, divisions);
  const out = [];
  for (let i = 0; i <= n; i++) {
    out.push(lerp(a, b, i / n));
  }
  return out;
}

/**
 * Projective-style divisions along line from A to B as seen from VP:
 * points are intersections of lines from VP through divisions on a reference segment.
 * @param {VanishingPoint} vp
 * @param {Vec2} refA
 * @param {Vec2} refB
 * @param {number} divisions
 */
export function divideAlongVP(vp, refA, refB, divisions) {
  const marks = divideSegment(refA, refB, divisions);
  const out = [];
  for (const m of marks) {
    if (vp.finite) out.push(m);
    else out.push(m);
  }
  return out;
}

/**
 * Compare two VPs; returns distance in pixels for finite, angle for infinite.
 */
export function vpMismatch(a, b) {
  if (!a || !b) return Infinity;
  if (a.finite && b.finite) return dist(a.p, b.p);
  if (!a.finite && !b.finite) {
    return Math.abs(cross(a.dir, b.dir));
  }
  return Infinity;
}
