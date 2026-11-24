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

/**
 * Pushes a circle out of a rectangle if they overlap (mutates the circle).
 * Because it pushes along the nearest direction, the player slides along walls
 * instead of sticking to them. Returns true if the circle had to be moved.
 */
export function pushCircleOutOfRect(c: Circle, r: Rect): boolean {
  const nearestX = clamp(c.x, r.x, r.x + r.width);
  const nearestY = clamp(c.y, r.y, r.y + r.height);
  const dx = c.x - nearestX;
  const dy = c.y - nearestY;
  const distSq = dx * dx + dy * dy;
  if (distSq >= c.radius * c.radius) return false;

  if (distSq > 1e-9) {
    const dist = Math.sqrt(distSq);
    const push = c.radius - dist;
    c.x += (dx / dist) * push;
    c.y += (dy / dist) * push;
    return true;
  }

  // The centre is inside the rectangle: leave through the closest side.
  const toLeft = c.x - r.x;
  const toRight = r.x + r.width - c.x;
  const toTop = c.y - r.y;
  const toBottom = r.y + r.height - c.y;
  const nearest = Math.min(toLeft, toRight, toTop, toBottom);
  if (nearest === toLeft) c.x = r.x - c.radius;
  else if (nearest === toRight) c.x = r.x + r.width + c.radius;
  else if (nearest === toTop) c.y = r.y - c.radius;
  else c.y = r.y + r.height + c.radius;
  return true;
}

/** True when two rectangles are closer to each other than `gap` pixels (or overlap). */
export function rectsTooClose(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x - gap < b.x + b.width &&
    a.x + a.width + gap > b.x &&
    a.y - gap < b.y + b.height &&
    a.y + a.height + gap > b.y
  );
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
