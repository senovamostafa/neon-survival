/**
 * Seeded random number generator (mulberry32).
 * Same seed => same sequence, which makes tests and bug reports reproducible.
 * Never use Math.random() inside game rules; always use this.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** A random seed for a fresh run (the only place Math.random is allowed). */
  static randomSeed(): number {
    return Math.floor(Math.random() * 0xffffffff);
  }
}
