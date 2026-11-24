export interface Circle {
  x: number;
  y: number;
  radius: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when two circles overlap (touching exactly does not count). */
export function circleHitsCircle(a: Circle, b: Circle): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = a.radius + b.radius;
  return dx * dx + dy * dy < r * r;
}

/** True when a circle overlaps a rectangle. */
export function circleHitsRect(c: Circle, r: Rect): boolean {
  // Closest point on the rectangle to the circle centre.
  const nearestX = clamp(c.x, r.x, r.x + r.width);
  const nearestY = clamp(c.y, r.y, r.y + r.height);
  const dx = c.x - nearestX;
  const dy = c.y - nearestY;
  return dx * dx + dy * dy < c.radius * c.radius;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
