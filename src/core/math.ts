// Vector math helpers. World coordinates are (x, y) on the ground plane.
// Isometric projection happens only at render time.

export interface Vec2 {
  x: number;
  y: number;
}

export function v(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  if (l < 1e-6) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Circle-circle overlap.
export function circlesOverlap(a: Vec2, ra: number, b: Vec2, rb: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = ra + rb;
  return dx * dx + dy * dy <= r * r;
}

// Signed orientation of three points (sign of the 2D cross product).
// Returns +1 / 0 / -1 — used by segmentsIntersect.
function orient(p: Vec2, q: Vec2, r: Vec2): number {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

// Returns true when segment a-b properly crosses segment c-d. Used
// by the cliff-cross detector in the engine. Co-linear / touching
// cases return false (conservative; movement skims along the edge
// without triggering a "cross").
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

// Perpendicular distance from point p to segment a-b (clamped at endpoints).
// Used for line-of-sight tests and any line-segment-vs-circle check.
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ablen2 = abx * abx + aby * aby;
  if (ablen2 < 1e-6) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / ablen2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}
