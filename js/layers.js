/**
 * Layer model. The layers array is ordered bottom→top (index 0 drawn first).
 *
 * Layer types:
 *   - background: { color } — full-viewport screen-space fill
 *   - grid:       { axis: 'x'|'y'|'z', color }
 *   - horizon:    { axes: ['x','y'|'z'] } — line through the two VPs, color
 *                 is derived dynamically from the corresponding grid layers
 *   - box:        wireframe + corner handles
 *   - image:      { image: HTMLImageElement, pos: {x,y}, scale, width, height }
 */

const GRID_HUES = { x: 10, y: 140, z: 205 };
const GRID_LABELS = { x: "X grid", y: "Y grid", z: "Z grid" };

/** Tunable saturation/lightness for the hue-driven palette. */
export const HUE_SATURATION = 65;
export const HUE_LIGHTNESS = 55;

export function hueToColor(h) {
  return `hsl(${h}, ${HUE_SATURATION}%, ${HUE_LIGHTNESS}%)`;
}

export function createDefaultLayers() {
  return [
    {
      id: "background",
      type: "background",
      name: "Background",
      visible: true,
      opacity: 1,
      color: "#1a1a1a",
    },
    makeGridLayer("x"),
    makeGridLayer("y"),
    makeGridLayer("z"),
    makeHorizonLayer("x", "y"),
    makeHorizonLayer("y", "z"),
    makeHorizonLayer("x", "z"),
    {
      id: "box",
      type: "box",
      name: "Wireframe box",
      visible: true,
      opacity: 1,
      hue: 0,
      color: "hsl(0, 0%, 92%)",
    },
  ];
}

function makeGridLayer(axis) {
  const hue = GRID_HUES[axis];
  return {
    id: `grid-${axis}`,
    type: "grid",
    axis,
    hue,
    color: hueToColor(hue),
    name: GRID_LABELS[axis],
    visible: true,
    opacity: 0.35,
  };
}

function makeHorizonLayer(a, b) {
  return {
    id: `horizon-${a}${b}`,
    type: "horizon",
    axes: [a, b],
    name: `V${a}${b} horizon`,
    visible: true,
    opacity: 0.8,
  };
}

let imageCounter = 0;
export function createImageLayer(image, name, viewportCenter, viewportSize) {
  imageCounter++;
  const fit = Math.min(
    (viewportSize.w * 0.6) / image.naturalWidth,
    (viewportSize.h * 0.6) / image.naturalHeight,
    1,
  );
  const scale = fit > 0 ? fit : 1;
  return {
    id: `img-${imageCounter}`,
    type: "image",
    name,
    visible: true,
    opacity: 1,
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    scale,
    pos: {
      x: viewportCenter.x - (image.naturalWidth * scale) / 2,
      y: viewportCenter.y - (image.naturalHeight * scale) / 2,
    },
  };
}

export function moveLayer(layers, id, direction) {
  const idx = layers.findIndex((l) => l.id === id);
  if (idx < 0) return layers;
  const next = idx + direction;
  if (next < 0 || next >= layers.length) return layers;
  const out = [...layers];
  [out[idx], out[next]] = [out[next], out[idx]];
  return out;
}

export function removeLayer(layers, id) {
  return layers.filter((l) => l.id !== id);
}

export function updateLayer(layers, id, patch) {
  return layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
}

/** Box layer center (centroid of 8 corners). */
export function boxCenter(corners) {
  let sx = 0;
  let sy = 0;
  for (const c of corners) {
    sx += c.x;
    sy += c.y;
  }
  return { x: sx / corners.length, y: sy / corners.length };
}

export function imageBounds(layer) {
  return {
    x0: layer.pos.x,
    y0: layer.pos.y,
    x1: layer.pos.x + layer.width * layer.scale,
    y1: layer.pos.y + layer.height * layer.scale,
  };
}

export function imageCenter(layer) {
  return {
    x: layer.pos.x + (layer.width * layer.scale) / 2,
    y: layer.pos.y + (layer.height * layer.scale) / 2,
  };
}

export function pointInImage(p, layer) {
  const b = imageBounds(layer);
  return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
}

/** Convex hull of box corners (Andrew's monotone chain). */
export function boxHull(corners) {
  const pts = corners.map((p) => ({ x: p.x, y: p.y }));
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
