import Phaser from 'phaser';
import { CONFIG } from '../core/config';
import { formatTime } from '../core/format';
import {
  createGame,
  startRun,
  stepGame,
  type GameState,
  type InputState,
} from '../core/game';
import { Rng } from '../core/rng';
import { FixedStepper } from '../core/stepper';
import { PALETTE, registerTextures } from './sprites';

const FONT = '"Press Start 2P", monospace';
const HUD_HEIGHT = CONFIG.arena.y - 8;

type KeyMap = Record<'W' | 'A' | 'S' | 'D' | 'SPACE' | 'ENTER', Phaser.Input.Keyboard.Key>;

/**
 * The only Phaser scene in Phase 1. It does three jobs and holds no game rules:
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
  private hazardSprites: Phaser.GameObjects.Image[] = [];
  private hearts: Phaser.GameObjects.Image[] = [];
  private timeText!: Phaser.GameObjects.Text;

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
    this.createHud();
    this.createOverlay();

    this.hero = this.add.image(0, 0, 'hero').setDepth(10);

    const keyboard = this.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.keys = keyboard.addKeys('W,A,S,D,SPACE,ENTER') as KeyMap;

    this.newRun();

    // Dev-only debug handle (stripped from production builds): window.__scene.state
    if (import.meta.env.DEV) (window as unknown as { __scene: GameScene }).__scene = this;
  }

  update(_time: number, deltaMs: number): void {
    const confirm =
      Phaser.Input.Keyboard.JustDown(this.keys.SPACE) ||
      Phaser.Input.Keyboard.JustDown(this.keys.ENTER);

    switch (this.state.status) {
      case 'ready':
        if (confirm) {
          startRun(this.state);
          this.stepper.reset();
          this.overlay.setVisible(false);
        }
        break;

      case 'playing': {
        const input = this.readInput();
        const steps = this.stepper.advance(deltaMs);
        for (let i = 0; i < steps; i++) {
          const result = stepGame(this.state, input, CONFIG.timestep.stepMs);
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

  // ---- run lifecycle -----------------------------------------------------

  /** Builds a fresh game and shows the "press space" screen. No page reload needed. */
  private newRun(): void {
    this.state = createGame(Rng.randomSeed());
    this.stepper.reset();

    this.hazardSprites.forEach((s) => s.destroy());
    this.hazardSprites = this.state.hazards.map(() =>
      this.add.image(0, 0, 'hazard').setDepth(5),
    );

    this.overlayTitle.setText('NEON SURVIVAL');
    this.overlayBody.setText('WASD OR ARROWS TO MOVE\nDODGE THE INVADERS');
    this.overlayPrompt.setText('PRESS SPACE TO START');
    this.overlay.setVisible(true);
    this.syncVisuals();
  }

  private showGameOver(): void {
    this.overlayTitle.setText('GAME OVER');
    this.overlayBody.setText(`SURVIVED ${formatTime(this.state.timeMs)}`);
    this.overlayPrompt.setText('PRESS SPACE TO PLAY AGAIN');
    this.overlay.setVisible(true);
  }

  // ---- drawing -----------------------------------------------------------

  /** Copies the core state onto the sprites. Positions are rounded to keep pixels crisp. */
  private syncVisuals(): void {
    const { player, hazards, timeMs } = this.state;

    this.hero.setPosition(Math.round(player.x), Math.round(player.y));
    // Blink while invulnerable.
    const blinkOff = player.invulnerableMs > 0 && Math.floor(player.invulnerableMs / 100) % 2 === 0;
    this.hero.setAlpha(blinkOff ? 0.25 : 1);

    hazards.forEach((h, i) => this.hazardSprites[i].setPosition(Math.round(h.x), Math.round(h.y)));

    this.timeText.setText(formatTime(timeMs));
    this.hearts.forEach((heart, i) =>
      heart.setTexture(i < player.lives ? 'heart' : 'heart-empty'),
    );
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
    g.lineStyle(2, Phaser.Display.Color.HexStringToColor(PALETTE.line).color, 1);
    g.strokeRect(arena.x - 1, arena.y - 1, arena.width + 2, arena.height + 2);
  }

  private createHud(): void {
    const bg = this.add.graphics().setDepth(20);
    bg.fillStyle(Phaser.Display.Color.HexStringToColor(PALETTE.hud).color, 1);
    bg.fillRect(0, 0, CONFIG.screen.width, HUD_HEIGHT);
    bg.fillStyle(Phaser.Display.Color.HexStringToColor(PALETTE.line).color, 1);
    bg.fillRect(0, HUD_HEIGHT, CONFIG.screen.width, 2);

    this.timeText = this.add
      .text(20, HUD_HEIGHT / 2, '00:00', { fontFamily: FONT, fontSize: '20px', color: PALETTE.text })
      .setOrigin(0, 0.5)
      .setDepth(21);

    const heartsX = CONFIG.screen.width - 20 - 3 * 30;
    for (let i = 0; i < CONFIG.player.lives; i++) {
      this.hearts.push(
        this.add.image(heartsX + i * 30, HUD_HEIGHT / 2, 'heart').setOrigin(0, 0.5).setDepth(21),
      );
    }
  }

  private createOverlay(): void {
    const { width, height } = CONFIG.screen;
    const dim = this.add
      .rectangle(0, 0, width, height, Phaser.Display.Color.HexStringToColor(PALETTE.hud).color, 0.82)
      .setOrigin(0, 0);

    this.overlayTitle = this.add
      .text(width / 2, 190, '', { fontFamily: FONT, fontSize: '36px', color: PALETTE.cyan })
      .setOrigin(0.5);
    this.overlayBody = this.add
      .text(width / 2, 280, '', { fontFamily: FONT, fontSize: '14px', color: PALETTE.text, align: 'center', lineSpacing: 14 })
      .setOrigin(0.5);
    this.overlayPrompt = this.add
      .text(width / 2, 380, '', { fontFamily: FONT, fontSize: '16px', color: PALETTE.yellow })
      .setOrigin(0.5);

    this.tweens.add({ targets: this.overlayPrompt, alpha: 0.2, duration: 600, yoyo: true, repeat: -1 });

    this.overlay = this.add
      .container(0, 0, [dim, this.overlayTitle, this.overlayBody, this.overlayPrompt])
      .setDepth(30);
  }
}
