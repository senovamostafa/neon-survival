import { CONFIG } from '../core/config';
import { FixedStepper } from '../core/stepper';
import { INTERP_DELAY_MS } from '../online/interpolation';
import type { OnlineApp } from '../online/app';
import { Predictor } from '../online/prediction';
import { buildViewState, eventsToStepResult } from '../online/view';
import { ABILITY_SLOTS, GameScene } from './GameScene';
import Phaser from 'phaser';

/** Never replay more than this many snapshots' worth of effects at once (a tab that was asleep). */
const MAX_EFFECT_BATCH = 20;

/**
 * The online arena. It draws with exactly the same code as the local game (GameScene) but the
 * match is not run here: every frame it builds a picture from the server's snapshots
 * (src/online/view.ts) and lets the inherited drawing code show it.
 *
 *  - Other heroes are drawn slightly in the past and slid between snapshots (interpolation).
 *  - Your own hero moves at once with the shared movement code and is gently corrected by the
 *    server's answers (prediction).
 *  - Keys are only sent as "I am holding this direction"; the server decides everything.
 */
export class OnlineScene extends GameScene {
  private app!: OnlineApp;
  private readonly predictor = new Predictor();
  private readonly predictStepper = new FixedStepper();
  private lastTick = -1;
  private wasLive = false;

  constructor() {
    super('OnlineScene');
  }

  protected begin(): void {
    this.app = this.registry.get('app') as OnlineApp;
    this.overlay.setVisible(false); // the HTML screens replace the local game's title and results
    this.state = buildViewState(this.app.session, null);
    this.syncVisuals();
  }

  protected advance(deltaMs: number): void {
    const { session } = this.app;
    const now = performance.now();
    this.localId = session.playerId ?? '';

    const playing = session.screen === 'playing' && !session.spectating;
    // Typing a nickname must not be eaten by the game's keys, so the keyboard is only live in a match.
    this.input.keyboard!.enabled = playing;

    this.state = buildViewState(session, session.snapshots.sample(now - INTERP_DELAY_MS));
    const state = this.state;

    // Sparks, shakes and flashes for what the server says happened.
    const known = new Set(state.players.map((p) => p.id));
    for (const ev of session.takeEvents().slice(-MAX_EFFECT_BATCH)) {
      this.showResult(eventsToStepResult(ev, known));
      for (const a of ev.abilities ?? []) {
        const mine = a.p === this.localId;
        this.playAbilityEffect(a.id, a.from, a.to, mine);
        if (mine && a.id === 'teleport') this.predictor.teleport(a.to.x, a.to.y, now, session.roundTripMs);
      }
    }
    for (const id of session.takeRefusals()) this.slotFlashUntil[id] = this.time.now + 300;

    // Keys that were pressed are always consumed, so one pressed in the lobby cannot fire later.
    const pressed = ABILITY_SLOTS.filter((slot) => Phaser.Input.Keyboard.JustDown(this.keys[slot.key]));

    const latest = session.snapshots.latest;
    const meNow = latest?.snap.players.find((p) => p.id === this.localId);
    const meShown = state.players.find((p) => p.id === this.localId);
    if (!latest || !meNow || !meShown) {
      this.wasLive = false;
      return;
    }

    const live = playing && meNow.alive && meNow.present;
    if (!live) {
      this.predictor.reset(meNow.x, meNow.y);
      this.wasLive = false;
      return;
    }
    if (!this.wasLive) {
      this.wasLive = true;
      this.predictor.reset(meNow.x, meNow.y);
      this.predictStepper.reset();
      this.lastTick = latest.snap.tick;
    }

    const input = this.readInput();
    this.app.sendInput(input.dx, input.dy);
    for (const slot of pressed) this.app.useAbility(slot.id);

    // Move our own hero right now, in the same fixed steps the server uses.
    const steps = this.predictStepper.advance(deltaMs);
    for (let i = 0; i < steps; i++) this.predictor.step(input, CONFIG.timestep.stepMs, state.barriers, now);

    // A new snapshot: compare with what the server says and nudge.
    if (latest.snap.tick !== this.lastTick) {
      this.lastTick = latest.snap.tick;
      this.predictor.reconcile(meNow, latest.at, session.roundTripMs);
    }

    meShown.x = this.predictor.x;
    meShown.y = this.predictor.y;
  }
}
