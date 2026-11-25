/**
 * Decides when to tell the server which keys are held. A message goes out when the direction
 * changes, and again every HEARTBEAT_MS while a key stays held (the server treats silence as
 * "standing still" after 600 ms, so a held key must be repeated). Nothing is sent while idle.
 */

export const HEARTBEAT_MS = 200;

export class InputSender {
  private dx = 0;
  private dy = 0;
  private sentAt = -Infinity;
  private sentSomething = false;

  /** Returns the message to send now, or null for "nothing new". */
  next(dx: number, dy: number, now: number): { dx: number; dy: number } | null {
    const changed = dx !== this.dx || dy !== this.dy;
    const moving = dx !== 0 || dy !== 0;
    if (changed || (moving && now - this.sentAt >= HEARTBEAT_MS)) {
      this.dx = dx;
      this.dy = dy;
      this.sentAt = now;
      this.sentSomething = true;
      return { dx, dy };
    }
    return null;
  }

  /** Call when a new match starts or the connection is replaced, so the next key press is always sent. */
  reset(): void {
    this.dx = 0;
    this.dy = 0;
    this.sentAt = -Infinity;
    this.sentSomething = false;
  }

  get hasSent(): boolean {
    return this.sentSomething;
  }
}
