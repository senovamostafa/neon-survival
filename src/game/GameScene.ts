import Phaser from 'phaser';
import { activateAbility } from '../core/abilities';
import { CONFIG } from '../core/config';
import { formatTime } from '../core/format';
import { createGame, startRun, stepGame } from '../core/game';
import { Rng } from '../core/rng';
import { FixedStepper } from '../core/stepper';
import type { AbilityId, GameState, InputState } from '../core/types';
import { PALETTE, registerTextures } from './sprites';

const FONT = '"Press Start 2P", monospace';
const HUD_HEIGHT = CONFIG.arena.y - 8;

const hex = (color: string): number => Phaser.Display.Color.HexStringToColor(color).color;
const COLOR = {
  line: hex(PALETTE.line),
  hud: hex(PALETTE.hud),
  cyan: hex(PALETTE.cyan),
  yellow: hex(PALETTE.yellow),
  indigo: hex(PALETTE.indigo),
  lightIndigo: hex(PALETTE.lightIndigo),
  red: hex(PALETTE.red),
  dim: hex(PALETTE.dimGrey),
  white: 0xffffff,
};

type KeyName = 'W' | 'A' | 'S' | 'D' | 'SPACE' | 'ENTER' | 'ONE' | 'TWO' | 'THREE' | 'FOUR';
type KeyMap = Record<KeyName, Phaser.Input.Keyboard.Key>;

/** The four ability slots in the HUD, in key order. */
const ABILITY_SLOTS: { id: AbilityId; key: KeyName; label: string }[] = [
  { id: 'shield', key: 'ONE', label: '1 SHIELD' },
  { id: 'slow', key: 'TWO', label: '2 SLOW' },
  { id: 'teleport', key: 'THREE', label: '3 WARP' },
  { id: 'magnet', key: 'FOUR', label: '4 MAGNET' },
];
const SLOT = { x: 400, y: 9, width: 100, height: 30, gap: 6 };
const ENERGY_BAR = { x: 170, y: 14, segmentWidth: 18, segmentHeight: 20, gap: 2, segments: 10 };

/**
 * The only Phaser scene. It does three jobs and holds no game rules:
 *  1. reads the keyboard,
 *  2. feeds fixed-size steps into the core game (src/core/game.ts),
 *  3. draws whatever the core says is true.
 */
export class GameScene extends Phaser.Scene {
  state!: GameState; // public only so the dev debug handle can inspect it
  private readonly stepper = new FixedStepper();
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: KeyMap;

  private hero!: Phaser.GameObjects.Image;
  private drifterSprites: Phaser.GameObjects.Image[] = [];
  private orbSprites: Phaser.GameObjects.Image[] = [];
  private hearts: Phaser.GameObjects.Image[] = [];
  private timeText!: Phaser.GameObjects.Text;
  private slotLabels: Phaser.GameObjects.Text[] = [];
  private slotCosts: Phaser.GameObjects.Text[] = [];
  private slotFlashUntil: Record<AbilityId, number> = { shield: 0, slow: 0, teleport: 0, magnet: 0 };

  private barrierGfx!: Phaser.GameObjects.Graphics;
  private trapGfx!: Phaser.GameObjects.Graphics;
  private ringGfx!: Phaser.GameObjects.Graphics;
  private hudGfx!: Phaser.GameObjects.Graphics;

  private overlay!: Phaser.GameObjects.Container;
  private overlayTitle!: Phaser.GameObjects.Text;
  private overlayBody!: Phaser.GameObjects.Text;
  private overlayPrompt!: Phaser.GameObjects.Text;

  constructor() {
    super('GameScene');
  }

  create(): void {
    registerTextures(this);
    this.cameras.main.setBackgroundColor(PALETTE.background);

    this.drawArena();
    this.barrierGfx = this.add.graphics().setDepth(1);
    this.trapGfx = this.add.graphics().setDepth(2);
    this.ringGfx = this.add.graphics().setDepth(11);
    this.createHud();
    this.createOverlay();

    this.hero = this.add.image(0, 0, 'hero').setDepth(10);

    const keyboard = this.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.keys = keyboard.addKeys('W,A,S,D,SPACE,ENTER,ONE,TWO,THREE,FOUR') as KeyMap;

    this.newRun();

    // Dev-only debug handle (stripped from production builds): window.__scene.state
    if (import.meta.env.DEV) (window as unknown as { __scene: GameScene }).__scene = this;
  }

  update(_time: number, deltaMs: number): void {
    const confirm =
      Phaser.Input.Keyboard.JustDown(this.keys.SPACE) ||
      Phaser.Input.Keyboard.JustDown(this.keys.ENTER);
    // Always consume the ability keys so a press on the title screen cannot fire later.
    const pressed = ABILITY_SLOTS.filter((slot) => Phaser.Input.Keyboard.JustDown(this.keys[slot.key]));

    switch (this.state.status) {
      case 'ready':
        if (confirm) {
          startRun(this.state);
          this.stepper.reset();
          this.overlay.setVisible(false);
        }
        break;

      case 'playing': {
        for (const slot of pressed) this.tryAbility(slot.id);

        const input = this.readInput();
        const steps = this.stepper.advance(deltaMs);
        for (let i = 0; i < steps; i++) {
          const result = stepGame(this.state, input, CONFIG.timestep.stepMs);
          for (const pickup of result.pickups) this.burst(pickup.x, pickup.y, COLOR.yellow, 6);
          if (result.shieldBlocked) {
            this.burst(this.state.player.x, this.state.player.y, COLOR.cyan, 12);
            this.cameras.main.shake(80, 0.004);
          }
          if (result.hit) this.cameras.main.shake(150, 0.008);
          if (result.gameOver) {
            this.showGameOver();
            break;
          }
        }
        break;
      }

      case 'gameover':
        if (confirm) this.newRun();
        break;
    }

    this.syncVisuals();
  }

  // ---- input -------------------------------------------------------------

  private readInput(): InputState {
    const left = this.cursors.left.isDown || this.keys.A.isDown;
    const right = this.cursors.right.isDown || this.keys.D.isDown;
    const up = this.cursors.up.isDown || this.keys.W.isDown;
    const down = this.cursors.down.isDown || this.keys.S.isDown;
    return { dx: Number(right) - Number(left), dy: Number(down) - Number(up) };
  }

  /** Asks the core to use an ability and shows feedback for success or refusal. */
  private tryAbility(id: AbilityId): void {
    const result = activateAbility(this.state, id);
    if (!result.ok) {
      this.slotFlashUntil[id] = this.time.now + 300; // red flash on the HUD slot
      return;
    }

    switch (id) {
      case 'shield':
        this.burst(result.to.x, result.to.y, COLOR.cyan, 10);
        break;
      case 'slow':
        this.cameras.main.flash(150, 138, 160, 255);
        break;
      case 'teleport':
        this.burst(result.from.x, result.from.y, COLOR.cyan, 14);
        this.burst(result.to.x, result.to.y, COLOR.cyan, 14);
        this.hero.setScale(1.8);
        this.tweens.add({ targets: this.hero, scale: 1, duration: 220 });
        break;
      case 'magnet':
        this.burst(result.to.x, result.to.y, COLOR.yellow, 10);
        break;
    }
  }

  // ---- run lifecycle -----------------------------------------------------

  /** Builds a fresh game and shows the "press space" screen. No page reload needed. */
  private newRun(): void {
    this.state = createGame(Rng.randomSeed());
    this.stepper.reset();
    this.drawBarriers();

    this.overlayTitle.setText('NEON SURVIVAL');
    this.overlayBody.setText(
      'WASD OR ARROWS TO MOVE\nGRAB ORBS FOR ENERGY\n1 SHIELD  2 SLOW  3 WARP  4 MAGNET',
    );
    this.overlayPrompt.setText('PRESS SPACE TO START');
    this.overlay.setVisible(true);
    this.syncVisuals();
  }

  private showGameOver(): void {
    this.overlayTitle.setText('GAME OVER');
    this.overlayBody.setText(
      `SURVIVED ${formatTime(this.state.timeMs)}\nORBS COLLECTED ${this.state.orbsCollected}`,
    );
    this.overlayPrompt.setText('PRESS SPACE TO PLAY AGAIN');
    this.overlay.setVisible(true);
  }

  // ---- drawing -----------------------------------------------------------

  /** Copies the core state onto the sprites. Positions are rounded to keep pixels crisp. */
  private syncVisuals(): void {
    const { player, drifters, orbs, timeMs, abilities } = this.state;
    const now = this.time.now;
    const blink = Math.floor(now / 120) % 2 === 0;

    this.hero.setPosition(Math.round(player.x), Math.round(player.y));
    const blinkOff = player.invulnerableMs > 0 && Math.floor(player.invulnerableMs / 100) % 2 === 0;
    this.hero.setAlpha(blinkOff ? 0.25 : 1);

    // Moving obstacles: harmless markers blink; slow motion tints them blue.
    this.syncPool(this.drifterSprites, drifters.length, () => this.add.image(0, 0, 'crab').setDepth(5));
    const slowed = abilities.slow.activeMs > 0;
    drifters.forEach((d, i) => {
      const sprite = this.drifterSprites[i];
      sprite.setTexture(d.kind).setPosition(Math.round(d.x), Math.round(d.y));
      sprite.setAlpha(d.warningMs > 0 ? (blink ? 0.9 : 0.3) : 1);
      if (slowed) sprite.setTint(0x8aa0ff);
      else sprite.clearTint();
    });

    // Orbs blink during their last 3 seconds.
    this.syncPool(this.orbSprites, orbs.length, () => this.add.image(0, 0, 'orb').setDepth(4));
    orbs.forEach((o, i) => {
      this.orbSprites[i]
        .setPosition(Math.round(o.x), Math.round(o.y))
        .setAlpha(o.ttlMs < 3000 && blink ? 0.3 : 1);
    });

    this.timeText.setText(formatTime(timeMs));
    this.hearts.forEach((heart, i) =>
      heart.setTexture(i < player.lives ? 'heart' : 'heart-empty'),
    );

    this.drawTrapsAndMarkers(now);
    this.drawRings(now);
    this.drawHud(now);
  }

  /** Grows or shrinks a pool of sprites to `count` and hides the unused ones. */
  private syncPool(
    pool: Phaser.GameObjects.Image[],
    count: number,
    make: () => Phaser.GameObjects.Image,
  ): void {
    while (pool.length < count) pool.push(make());
    pool.forEach((sprite, i) => sprite.setVisible(i < count));
  }

  /** Danger zones, plus the direction arrows shown for obstacles that are about to move. */
  private drawTrapsAndMarkers(now: number): void {
    const g = this.trapGfx;
    g.clear();
    const blink = Math.floor(now / 150) % 2 === 0;

    for (const t of this.state.traps) {
      if (t.warningMs > 0) {
        if (blink) this.ringDots(g, t.x, t.y, t.radius, 36, 4, COLOR.red, 1);
      } else {
        const fading = t.activeMs < 1000 && blink;
        g.fillStyle(COLOR.red, fading ? 0.1 : 0.25);
        g.fillCircle(Math.round(t.x), Math.round(t.y), t.radius);
        this.ringDots(g, t.x, t.y, t.radius, 36, 4, COLOR.red, 1);
        g.fillStyle(COLOR.red, 1); // a pixel "X" in the middle
        for (let k = -2; k <= 2; k++) {
          g.fillRect(Math.round(t.x) + k * 4 - 2, Math.round(t.y) + k * 4 - 2, 4, 4);
          g.fillRect(Math.round(t.x) + k * 4 - 2, Math.round(t.y) - k * 4 - 2, 4, 4);
        }
      }
    }

    // Four dots show where a warning obstacle is about to go.
    g.fillStyle(COLOR.white, 0.7);
    for (const d of this.state.drifters) {
      if (d.warningMs <= 0) continue;
      const speed = Math.hypot(d.vx, d.vy);
      for (let k = 1; k <= 4; k++) {
        const dist = d.radius + 10 + k * 14;
        g.fillRect(Math.round(d.x + (d.vx / speed) * dist) - 2, Math.round(d.y + (d.vy / speed) * dist) - 2, 4, 4);
      }
    }
  }

  /** Shield square and magnet range, drawn around the hero. */
  private drawRings(now: number): void {
    const g = this.ringGfx;
    g.clear();
    const { player, abilities } = this.state;
    const x = Math.round(player.x);
    const y = Math.round(player.y);
    const blink = Math.floor(now / 120) % 2 === 0;

    const shield = abilities.shield.activeMs;
    if (shield > 0 && (shield > 1500 || blink)) {
      g.lineStyle(3, COLOR.cyan, 1);
      g.strokeRect(x - 22, y - 22, 44, 44);
    }

    const magnet = abilities.magnet.activeMs;
    if (magnet > 0 && (magnet > 1500 || blink)) {
      this.ringDots(g, x, y, CONFIG.abilities.magnet.radius, 48, 3, COLOR.yellow, 0.5);
    }
  }

  /** Time, energy bar and the four ability slots. Redrawn every frame; it is only a few rectangles. */
  private drawHud(now: number): void {
    const g = this.hudGfx;
    g.clear();
    const state = this.state;

    // Energy bar: ten blocks, each worth a tenth of the maximum.
    const perBlock = CONFIG.energy.max / ENERGY_BAR.segments;
    const filled = Math.floor(state.energy / perBlock);
    for (let i = 0; i < ENERGY_BAR.segments; i++) {
      const x = ENERGY_BAR.x + i * (ENERGY_BAR.segmentWidth + ENERGY_BAR.gap);
      g.fillStyle(i < filled ? COLOR.cyan : COLOR.dim, i < filled ? 1 : 0.35);
      g.fillRect(x, ENERGY_BAR.y, ENERGY_BAR.segmentWidth, ENERGY_BAR.segmentHeight);
    }

    ABILITY_SLOTS.forEach((slot, i) => {
      const spec = CONFIG.abilities[slot.id];
      const ability = state.abilities[slot.id];
      const x = SLOT.x + i * (SLOT.width + SLOT.gap);
      const affordable = state.energy >= spec.cost;
      const ready = affordable && ability.cooldownMs <= 0 && ability.activeMs <= 0;
      const flashing = now < this.slotFlashUntil[slot.id];
      const active = ability.activeMs > 0;

      const border = flashing ? COLOR.red : active ? COLOR.cyan : ready ? COLOR.white : COLOR.dim;
      g.lineStyle(2, border, 1);
      g.strokeRect(x, SLOT.y, SLOT.width, SLOT.height);

      // Progress bar along the bottom: remaining effect time (cyan) or cooldown recharge (grey).
      const barWidth = SLOT.width - 12;
      const barY = SLOT.y + SLOT.height - 9;
      if (active && 'durationMs' in spec) {
        g.fillStyle(COLOR.cyan, 1);
        g.fillRect(x + 6, barY, Math.round(barWidth * (ability.activeMs / spec.durationMs)), 4);
      } else if (ability.cooldownMs > 0) {
        g.fillStyle(COLOR.dim, 1);
        g.fillRect(x + 6, barY, Math.round(barWidth * (1 - ability.cooldownMs / spec.cooldownMs)), 4);
      }

      const textColor = ready || active ? PALETTE.text : PALETTE.dimGrey;
      this.slotLabels[i].setColor(flashing ? PALETTE.red : textColor);
      this.slotCosts[i].setColor(affordable ? PALETTE.yellow : PALETTE.dimGrey);
    });
  }

  /** Draws a ring of small squares, which looks more "pixel" than a smooth circle. */
  private ringDots(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    radius: number,
    count: number,
    size: number,
    color: number,
    alpha: number,
  ): void {
    g.fillStyle(color, alpha);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      g.fillRect(
        Math.round(cx + Math.cos(angle) * radius - size / 2),
        Math.round(cy + Math.sin(angle) * radius - size / 2),
        size,
        size,
      );
    }
  }

  /** A quick burst of little squares flying outwards, used for pickups, shield and teleport. */
  private burst(x: number, y: number, color: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const piece = this.add.rectangle(Math.round(x), Math.round(y), 4, 4, color).setDepth(15);
      this.tweens.add({
        targets: piece,
        x: Math.round(x + Math.cos(angle) * 30),
        y: Math.round(y + Math.sin(angle) * 30),
        alpha: 0,
        duration: 350,
        onComplete: () => piece.destroy(),
      });
    }
  }

  private drawBarriers(): void {
    const g = this.barrierGfx;
    g.clear();
    for (const b of this.state.barriers) {
      g.fillStyle(COLOR.indigo, 1);
      g.fillRect(b.x, b.y, b.width, b.height);
      g.lineStyle(2, COLOR.lightIndigo, 1);
      g.strokeRect(b.x + 1, b.y + 1, b.width - 2, b.height - 2);
    }
  }

  private drawArena(): void {
    const { arena } = CONFIG;
    const g = this.add.graphics().setDepth(0);

    // Dotted floor, like the reference pattern.
    g.fillStyle(0xffffff, 1);
    for (let y = arena.y + 12; y < arena.y + arena.height; y += 24) {
      for (let x = arena.x + 12; x < arena.x + arena.width; x += 24) g.fillRect(x, y, 2, 2);
    }

    // Border, drawn just outside the playable area so sprites touch its inner edge.
    g.lineStyle(2, COLOR.line, 1);
    g.strokeRect(arena.x - 1, arena.y - 1, arena.width + 2, arena.height + 2);
  }

  private createHud(): void {
    const bg = this.add.graphics().setDepth(20);
    bg.fillStyle(COLOR.hud, 1);
    bg.fillRect(0, 0, CONFIG.screen.width, HUD_HEIGHT);
    bg.fillStyle(COLOR.line, 1);
    bg.fillRect(0, HUD_HEIGHT, CONFIG.screen.width, 2);
    this.hudGfx = this.add.graphics().setDepth(21);

    const style = { fontFamily: FONT, fontSize: '20px', color: PALETTE.text };
    this.timeText = this.add.text(20, HUD_HEIGHT / 2, '00:00', style).setOrigin(0, 0.5).setDepth(22);
    this.add
      .text(ENERGY_BAR.x - 10, HUD_HEIGHT / 2, 'EN', { fontFamily: FONT, fontSize: '10px', color: PALETTE.grey })
      .setOrigin(1, 0.5)
      .setDepth(22);

    ABILITY_SLOTS.forEach((slot, i) => {
      const x = SLOT.x + i * (SLOT.width + SLOT.gap);
      const small = { fontFamily: FONT, fontSize: '8px', color: PALETTE.text };
      this.slotLabels.push(this.add.text(x + 6, SLOT.y + 6, slot.label, small).setDepth(22));
      this.slotCosts.push(
        this.add
          .text(x + SLOT.width - 6, SLOT.y + 6, String(CONFIG.abilities[slot.id].cost), small)
          .setOrigin(1, 0)
          .setDepth(22),
      );
    });

    const heartsX = CONFIG.screen.width - 20 - 3 * 30;
    for (let i = 0; i < CONFIG.player.lives; i++) {
      this.hearts.push(
        this.add.image(heartsX + i * 30, HUD_HEIGHT / 2, 'heart').setOrigin(0, 0.5).setDepth(22),
      );
    }
  }

  private createOverlay(): void {
    const { width, height } = CONFIG.screen;
    const dim = this.add.rectangle(0, 0, width, height, COLOR.hud, 0.82).setOrigin(0, 0);

    this.overlayTitle = this.add
      .text(width / 2, 190, '', { fontFamily: FONT, fontSize: '36px', color: PALETTE.cyan })
      .setOrigin(0.5);
    this.overlayBody = this.add
      .text(width / 2, 285, '', { fontFamily: FONT, fontSize: '14px', color: PALETTE.text, align: 'center', lineSpacing: 14 })
      .setOrigin(0.5);
    this.overlayPrompt = this.add
      .text(width / 2, 390, '', { fontFamily: FONT, fontSize: '16px', color: PALETTE.yellow })
      .setOrigin(0.5);

    this.tweens.add({ targets: this.overlayPrompt, alpha: 0.2, duration: 600, yoyo: true, repeat: -1 });

    this.overlay = this.add
      .container(0, 0, [dim, this.overlayTitle, this.overlayBody, this.overlayPrompt])
      .setDepth(30);
  }
}
