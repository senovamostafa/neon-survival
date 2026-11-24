import { CONFIG } from './config';

/**
 * Turns variable frame times into a whole number of fixed simulation steps.
 *
 * Each rendered frame we add the elapsed time, then run as many fixed steps as fit.
 * The leftover time carries over to the next frame, so nothing is lost or invented.
 */
export class FixedStepper {
  private accumulatorMs = 0;

  constructor(
    private readonly stepMs: number = CONFIG.timestep.stepMs,
    private readonly maxFrameMs: number = CONFIG.timestep.maxFrameMs,
  ) {}

  /** Returns how many fixed steps to simulate for this frame. */
  advance(frameMs: number): number {
    this.accumulatorMs += Math.min(Math.max(frameMs, 0), this.maxFrameMs);
    let steps = 0;
    // The small epsilon avoids losing a step to floating point error (e.g. 16.6666 vs 16.6667).
    while (this.accumulatorMs >= this.stepMs - 1e-9) {
      this.accumulatorMs -= this.stepMs;
      steps++;
    }
    return steps;
  }

  reset(): void {
    this.accumulatorMs = 0;
  }
}
