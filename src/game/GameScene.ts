import Phaser from 'phaser';
import { activateAbility } from '../core/abilities';
import { botAbility, botInput } from '../core/bots';
import { CONFIG } from '../core/config';
import { getDifficulty } from '../core/difficulty';
import { formatTime } from '../core/format';
import { createMatch, startRun, stepGame } from '../core/game';
import { rankPlayers } from '../core/ranking';
import { Rng } from '../core/rng';
import { FixedStepper } from '../core/stepper';
import type { AbilityId, GameState, InputMap, InputState, Player } from '../core/types';
import { HERO_PALETTE, PALETTE, registerTextures } from './sprites';
import { THEMES } from './themes';

export const FONT = '"Press Start 2P", monospace';
const HUD_HEIGHT = CONFIG.arena.y - 8;

/** This browser's player. The others are computer-controlled until the online version exists. */
const LOCAL_ID = 'p1';
const BOT_COUNT = 3;

/** Stands in for "you" while watching a match without a hero of your own. */
const SPECTATOR: Player = {
  id: '',
  name: '',
  colorIndex: 0,
  x: 0,
  y: 0,
  radius: 0,
  lives: 0,
  invulnerableMs: 0,
  alive: false,
  respawnMs: 0,
  deaths: 0,
  energy: 0,
  orbs: 0,
  lastOrbAtMs: null,
  abilities: {
    shield: { activeMs: 0, cooldownMs: 0 },
    slow: { activeMs: 0, cooldownMs: 0 },
    teleport: { activeMs: 0, cooldownMs: 0 },
    magnet: { activeMs: 0, cooldownMs: 0 },
  },
  bumpVx: 0,
  bumpVy: 0,
  bumpMs: 0,
  connected: false,
  awayMs: 0,
  present: false,
};

const hex = (color: string): number => Phaser.Display.Color.HexStringToColor(color).color;
const COLOR = {
  line: hex(PALETTE.line),
  hud: hex(PALETTE.hud),
  cyan: hex(PALETTE.cyan),
  yellow: hex(PALETTE.yellow),
  red: hex(PALETTE.red),
  dim: hex(PALETTE.dimGrey),
  white: 0xffffff,
  slow: 0x8aa0ff,
};

export type KeyName = 'W' | 'A' | 'S' | 'D' | 'SPACE' | 'ENTER' | 'ONE' | 'TWO' | 'THREE' | 'FOUR';
export type KeyMap = Record<KeyName, Phaser.Input.Keyboard.Key>;

/** The four ability slots in the HUD, in key order. */
export const ABILITY_SLOTS: { id: AbilityId; key: KeyName; label: string }[] = [
  { id: 'shield', key: 'ONE', label: '1 SHIELD' },
  { id: 'slow', key: 'TWO', label: '2 SLOW' },
  { id: 'teleport', key: 'THREE', label: '3 WARP' },
  { id: 'magnet', key: 'FOUR', label: '4 MAGNET' },
];
const SLOT = { x: 425, y: 9, width: 100, height: 30, gap: 6 };
const ENERGY_BAR = { x: 215, y: 14, segmentWidth: 18, segmentHeight: 20, gap: 2, segments: 10 };
const SCOREBOARD = { width: 168, rowHeight: 12, maxRows: 10 };

/**
 * The only Phaser scene. It does three jobs and holds no game rules:
 *  1. reads the keyboard (and asks the bots what they want to do),
 *  2. feeds fixed-size steps into the core match (src/core/game.ts),
 *  3. draws whatever the core says is true.
 *
 * For now it runs a local match: you plus a few bots. The online version will feed the
 * same drawing code with state from the server instead.
 */
export class GameScene extends Phaser.Scene {
  state!: GameState; // public only so the dev debug handle can inspect it
  /** Whose hero is "you" on this screen. */
  protected localId = LOCAL_ID;
  protected readonly stepper = new FixedStepper();
  protected cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  protected keys!: KeyMap;

  protected heroSprites: Phaser.GameObjects.Image[] = [];
  protected heroNames: Phaser.GameObjects.Text[] = [];
  protected drifterSprites: Phaser.GameObjects.Image[] = [];
  protected orbSprites: Phaser.GameObjects.Image[] = [];
  protected hearts: Phaser.GameObjects.Image[] = [];
  protected timeText!: Phaser.GameObjects.Text;
  protected orbText!: Phaser.GameObjects.Text;
  protected slotLabels: Phaser.GameObjects.Text[] = [];
  protected slotCosts: Phaser.GameObjects.Text[] = [];
  protected slotFlashUntil: Record<AbilityId, number> = { shield: 0, slow: 0, teleport: 0, magnet: 0 };
  protected scoreRows: Phaser.GameObjects.Text[] = [];

  protected arenaGfx!: Phaser.GameObjects.Graphics;
  protected scoreGfx!: Phaser.GameObjects.Graphics;
  protected bannerTitle!: Phaser.GameObjects.Text;
  protected bannerSub!: Phaser.GameObjects.Text;
  protected statusText!: Phaser.GameObjects.Text;
  protected themeIndex = 0;
  protected lastSector = 0;
  protected sectorBannerUntil = 0;
  protected barrierGfx!: Phaser.GameObjects.Graphics;
  protected markerGfx!: Phaser.GameObjects.Graphics;
  protected ringGfx!: Phaser.GameObjects.Graphics;
  protected hudGfx!: Phaser.GameObjects.Graphics;

  protected overlay!: Phaser.GameObjects.Container;
  protected overlayTitle!: Phaser.GameObjects.Text;
  protected overlayBody!: Phaser.GameObjects.Text;
  protected overlayPrompt!: Phaser.GameObjects.Text;

  constructor(key = 'GameScene') {
    super(key);
  }

  /** The player on this screen (a blank stand-in when watching without a hero). */
  protected get me(): Player {
    return this.state.players.find((p) => p.id === this.localId) ?? SPECTATOR;
  }

  create(): void {
    registerTextures(this);
    this.cameras.main.setBackgroundColor(PALETTE.background);

    this.arenaGfx = this.add.graphics().setDepth(0);
    this.drawArena();
    this.barrierGfx = this.add.graphics().setDepth(1);
    this.markerGfx = this.add.graphics().setDepth(2);
    this.ringGfx = this.add.graphics().setDepth(11);
    this.createHud();
    this.createScoreboard();
    this.createBanners();
    this.createOverlay();

    const keyboard = this.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.keys = keyboard.addKeys('W,A,S,D,SPACE,ENTER,ONE,TWO,THREE,FOUR') as KeyMap;

    this.begin();

    // Dev-only debug handle (stripped from production builds): window.__scene.state
    if (import.meta.env.DEV) (window as unknown as { __scene: GameScene }).__scene = this;
  }

  update(_time: number, deltaMs: number): void {
    this.advance(deltaMs);
    this.syncVisuals();
  }

  /** Where the local game starts. The online scene starts differently. */
  protected begin(): void {
    this.newMatch();
  }

  /** Moves the game forward by one frame: input, bots, the core steps. The online scene replaces this. */
  protected advance(deltaMs: number): void {
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

        const steps = this.stepper.advance(deltaMs);
        for (let i = 0; i < steps; i++) {
          this.runBots();
          const result = stepGame(this.state, this.collectInputs(), CONFIG.timestep.stepMs);
          this.showResult(result);
          if (result.finished) {
            this.showResults();
            break;
          }
        }
        break;
      }

      case 'finished':
        if (confirm) this.newMatch();
        break;
    }
  }

  // ---- input -------------------------------------------------------------

  protected readInput(): InputState {
    const left = this.cursors.left.isDown || this.keys.A.isDown;
    const right = this.cursors.right.isDown || this.keys.D.isDown;
    const up = this.cursors.up.isDown || this.keys.W.isDown;
    const down = this.cursors.down.isDown || this.keys.S.isDown;
    return { dx: Number(right) - Number(left), dy: Number(down) - Number(up) };
  }

  /** Keyboard for you, the bot brain for everyone else. */
  protected collectInputs(): InputMap {
    const inputs: InputMap = {};
    for (const p of this.state.players) {
      inputs[p.id] = p.id === this.localId ? this.readInput() : botInput(this.state, p.id);
    }
    return inputs;
  }

  protected runBots(): void {
    for (const p of this.state.players) {
      if (p.id === this.localId) continue;
      const ability = botAbility(this.state, p.id);
      if (ability) activateAbility(this.state, p.id, ability);
    }
  }

  /** Asks the core to use one of your abilities and shows feedback for success or refusal. */
  protected tryAbility(id: AbilityId): void {
    const result = activateAbility(this.state, this.localId, id);
    if (!result.ok) {
      this.slotFlashUntil[id] = this.time.now + 300; // red flash on the HUD slot
      return;
    }

    this.playAbilityEffect(id, result.from, result.to, true);
  }

  /** Sparks and flashes for an ability. `mine` makes the screen flash for the player's own slow-motion. */
  protected playAbilityEffect(
    id: AbilityId,
    from: { x: number; y: number },
    to: { x: number; y: number },
    mine: boolean,
  ): void {
    switch (id) {
      case 'shield':
        this.burst(to.x, to.y, COLOR.cyan, 10);
        break;
      case 'slow':
        if (mine) this.cameras.main.flash(150, 138, 160, 255);
        else this.burst(to.x, to.y, COLOR.slow, 8);
        break;
      case 'teleport': {
        this.burst(from.x, from.y, COLOR.cyan, 14);
        this.burst(to.x, to.y, COLOR.cyan, 14);
        const index = this.state.players.findIndex((p) => p.id === this.localId);
        const hero = mine ? this.heroSprites[index] : undefined;
        if (hero) {
          hero.setScale(1.8);
          this.tweens.add({ targets: hero, scale: 1, duration: 220 });
        }
        break;
      }
      case 'magnet':
        this.burst(to.x, to.y, COLOR.yellow, 10);
        break;
    }
  }

  /** Turns what happened in a step into sparks and screen shakes. */
  protected showResult(result: ReturnType<typeof stepGame>): void {
    const at = (id: string) => this.state.players.find((p) => p.id === id)!;

    for (const pickup of result.pickups) this.burst(pickup.x, pickup.y, hex(HERO_PALETTE[at(pickup.playerId).colorIndex]), 6);
    for (const b of result.shieldBlocks) {
      const p = at(b.playerId);
      this.burst(p.x, p.y, COLOR.cyan, 12);
      if (p.id === this.localId) this.cameras.main.shake(80, 0.004);
    }
    for (const h of result.hits) if (h.playerId === this.localId) this.cameras.main.shake(150, 0.008);
    for (const d of result.deaths) {
      const p = at(d.playerId);
      this.burst(p.x, p.y, COLOR.red, 14);
      if (p.id === this.localId) this.cameras.main.shake(300, 0.012);
    }
    for (const r of result.respawns) {
      const p = at(r.playerId);
      this.burst(p.x, p.y, COLOR.cyan, 12);
    }
    for (const w of result.wallHits) this.burst(w.x, w.y, COLOR.dim, 5);
    for (const b of result.bumps) {
      const a = at(b.a);
      const c = at(b.b);
      this.burst((a.x + c.x) / 2, (a.y + c.y) / 2, COLOR.white, 6);
    }
  }

  // ---- match lifecycle ---------------------------------------------------

  /** Builds a fresh local match (you plus bots) and shows the "press space" screen. */
  protected newMatch(): void {
    const roster = [
      { id: this.localId, name: 'YOU' },
      ...Array.from({ length: BOT_COUNT }, (_, i) => ({ id: `b${i + 1}`, name: `BOT ${i + 1}` })),
    ];
    this.state = createMatch(Rng.randomSeed(), roster);
    this.stepper.reset();
    this.lastSector = 0;
    this.sectorBannerUntil = 0;
    this.applyTheme(0);

    this.overlayTitle.setText('NEON SURVIVAL');
    this.overlayBody.setText(
      `LOCAL MATCH: YOU + ${BOT_COUNT} BOTS\nMOST ORBS IN 4 MINUTES WINS\n\nWASD OR ARROWS TO MOVE\nENEMIES VANISH WHEN THEY HIT A WALL\n1 SHIELD  2 SLOW  3 WARP  4 MAGNET`,
    );
    this.overlayPrompt.setText('PRESS SPACE TO START');
    this.overlay.setVisible(true);
    this.syncVisuals();
  }

  protected showResults(): void {
    const table = rankPlayers(this.state);
    const lines = table.map(
      (r) => `${String(r.rank).padStart(2)}. ${r.name.padEnd(7)} ${String(r.orbs).padStart(3)} ORBS`,
    );
    this.overlayTitle.setText('MATCH OVER');
    this.overlayBody.setText(lines.join('\n'));
    this.overlayPrompt.setText('PRESS SPACE TO PLAY AGAIN');
    this.overlay.setVisible(true);
  }

  // ---- drawing -----------------------------------------------------------

  /** Copies the core state onto the sprites. Positions are rounded to keep pixels crisp. */
  protected syncVisuals(): void {
    const { players, drifters, orbs } = this.state;
    const me = this.me;
    const now = this.time.now;
    const blink = Math.floor(now / 120) % 2 === 0;

    // Heroes: one sprite and one name label per player.
    this.syncPool(this.heroSprites, players.length, (i) => this.add.image(0, 0, `hero-${players[i].colorIndex}`));
    while (this.heroNames.length < players.length) {
      this.heroNames.push(
        this.add
          .text(0, 0, '', { fontFamily: FONT, fontSize: '8px', color: '#ffffff' })
          .setOrigin(0.5)
          .setStroke(PALETTE.hud, 3)
          .setDepth(13),
      );
    }
    players.forEach((p, i) => {
      const sprite = this.heroSprites[i];
      const label = this.heroNames[i];
      sprite.setTexture(`hero-${p.colorIndex}`).setDepth(p.id === this.localId ? 10 : 9);
      sprite.setVisible(p.present);
      label.setVisible(p.present && p.alive);
      if (!p.present) return;

      sprite.setPosition(Math.round(p.x), Math.round(p.y));
      const blinkOff = p.invulnerableMs > 0 && Math.floor(p.invulnerableMs / 100) % 2 === 0;
      sprite.setAlpha(!p.alive ? 0.18 : blinkOff ? 0.3 : 1);
      label
        .setText(p.name)
        .setColor(HERO_PALETTE[p.colorIndex])
        .setPosition(Math.round(p.x), Math.round(p.y) - 24);
    });

    // Moving obstacles: harmless markers blink; any active slow-motion zone tints the ones inside it.
    this.syncPool(this.drifterSprites, drifters.length, () => this.add.image(0, 0, 'crab').setDepth(5));
    const zones = players.filter((p) => p.present && p.alive && p.abilities.slow.activeMs > 0);
    drifters.forEach((d, i) => {
      const sprite = this.drifterSprites[i];
      sprite.setTexture(d.kind).setPosition(Math.round(d.x), Math.round(d.y));
      sprite.setAlpha(d.warningMs > 0 ? (blink ? 0.9 : 0.3) : 1);
      const slowed = zones.some((p) => Math.hypot(d.x - p.x, d.y - p.y) <= CONFIG.abilities.slow.radius);
      if (slowed) sprite.setTint(COLOR.slow);
      else sprite.clearTint();
    });

    // Orbs blink during their last 3 seconds.
    this.syncPool(this.orbSprites, orbs.length, () => this.add.image(0, 0, 'orb').setDepth(4));
    orbs.forEach((o, i) => {
      this.orbSprites[i]
        .setPosition(Math.round(o.x), Math.round(o.y))
        .setAlpha(o.ttlMs < 3000 && blink ? 0.3 : 1);
    });

    const remaining = Math.max(0, CONFIG.match.durationMs - this.state.timeMs);
    this.timeText.setText(formatTime(Math.ceil(remaining / 1000) * 1000));
    this.orbText.setText(`ORB ${me.orbs}`);
    this.hearts.forEach((heart, i) => heart.setTexture(i < me.lives ? 'heart' : 'heart-empty'));

    this.handleSectorChange(now);
    this.drawBarriers(now);
    this.drawMarkers();
    this.drawRings(now);
    this.drawHud(now);
    this.drawScoreboard();
    this.updateBanners(now);
  }

  // ---- sectors -----------------------------------------------------------

  /** A new sector means a new colour theme, a flash and a banner. */
  protected handleSectorChange(now: number): void {
    const { sector } = this.state;
    if (sector === this.lastSector) return;
    this.lastSector = sector;
    this.applyTheme(sector);
    this.cameras.main.flash(300, 255, 255, 255);
    this.sectorBannerUntil = now + 2500;
  }

  protected applyTheme(index: number): void {
    this.themeIndex = index % THEMES.length;
    this.cameras.main.setBackgroundColor(THEMES[this.themeIndex].background);
    this.drawArena();
  }

  /** "You are down" and sector banners, and the status line. */
  protected updateBanners(now: number): void {
    const state = this.state;
    const me = this.me;
    const secs = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

    let title = '';
    let sub = '';
    let color: string = PALETTE.red;
    if (state.status === 'playing' && me.present && !me.alive) {
      title = 'YOU ARE DOWN';
      sub = `BACK IN ${secs(me.respawnMs)}`;
      color = PALETTE.yellow;
    } else if (now < this.sectorBannerUntil && state.status !== 'finished') {
      title = `SECTOR ${state.sector + 1}`;
      sub = THEMES[this.themeIndex].name.toUpperCase();
    }
    this.bannerTitle.setText(title).setColor(color).setVisible(title !== '');
    this.bannerSub.setText(sub).setVisible(title !== '');

    const tier = getDifficulty(state.timeMs, CONFIG).tier.toUpperCase();
    this.statusText.setText(`LEVEL ${tier}   SECTOR ${state.sector + 1}   DEATHS ${me.deaths}`);
  }

  protected createBanners(): void {
    const { width } = CONFIG.screen;
    this.bannerTitle = this.add
      .text(width / 2, 110, '', { fontFamily: FONT, fontSize: '22px', color: PALETTE.red })
      .setOrigin(0.5)
      .setDepth(25);
    this.bannerSub = this.add
      .text(width / 2, 142, '', { fontFamily: FONT, fontSize: '12px', color: PALETTE.text })
      .setOrigin(0.5)
      .setDepth(25);
    this.statusText = this.add
      .text(CONFIG.arena.x, CONFIG.screen.height - 9, '', { fontFamily: FONT, fontSize: '8px', color: PALETTE.dimGrey })
      .setOrigin(0, 0.5)
      .setDepth(25);
  }

  // ---- scoreboard --------------------------------------------------------

  protected createScoreboard(): void {
    this.scoreGfx = this.add.graphics().setDepth(24);
    for (let i = 0; i < SCOREBOARD.maxRows; i++) {
      this.scoreRows.push(
        this.add.text(0, 0, '', { fontFamily: FONT, fontSize: '8px', color: '#ffffff' }).setDepth(25).setVisible(false),
      );
    }
  }

  /** Live standings in the corner of the arena. */
  protected drawScoreboard(): void {
    const { arena } = CONFIG;
    const table = rankPlayers(this.state);
    const x = arena.x + arena.width - SCOREBOARD.width - 6;
    const y = arena.y + 6;
    const g = this.scoreGfx;
    g.clear();
    g.fillStyle(COLOR.hud, 0.62);
    g.fillRect(x, y, SCOREBOARD.width, table.length * SCOREBOARD.rowHeight + 8);

    this.scoreRows.forEach((row, i) => {
      const entry = table[i];
      if (!entry) {
        row.setVisible(false);
        return;
      }
      const player = this.state.players.find((p) => p.id === entry.playerId)!;
      const you = player.id === this.localId ? '>' : ' ';
      const name = entry.name.slice(0, 7).padEnd(7);
      row
        .setVisible(true)
        .setText(`${you}${entry.rank} ${name} ${String(entry.orbs).padStart(3)}`)
        .setColor(player.present ? HERO_PALETTE[player.colorIndex] : PALETTE.dimGrey)
        .setPosition(x + 6, y + 6 + i * SCOREBOARD.rowHeight);
    });
  }

  // ---- pools and shapes --------------------------------------------------

  /** Grows or shrinks a pool of sprites to `count` and hides the unused ones. */
  protected syncPool(
    pool: Phaser.GameObjects.Image[],
    count: number,
    make: (index: number) => Phaser.GameObjects.Image,
  ): void {
    while (pool.length < count) pool.push(make(pool.length));
    pool.forEach((sprite, i) => sprite.setVisible(i < count));
  }

  /** Direction dots shown next to an obstacle that is about to start moving. */
  protected drawMarkers(): void {
    const g = this.markerGfx;
    g.clear();

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

  /** Shield squares, magnet range and slow-motion zones, drawn around every player who has them on. */
  protected drawRings(now: number): void {
    const g = this.ringGfx;
    g.clear();
    const blink = Math.floor(now / 120) % 2 === 0;

    for (const p of this.state.players) {
      if (!p.present || !p.alive) continue;
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      const mine = p.id === this.localId;

      const shield = p.abilities.shield.activeMs;
      if (shield > 0 && (shield > 1500 || blink)) {
        g.lineStyle(3, COLOR.cyan, mine ? 1 : 0.7);
        g.strokeRect(x - 22, y - 22, 44, 44);
      }

      const magnet = p.abilities.magnet.activeMs;
      if (magnet > 0 && (magnet > 1500 || blink)) {
        this.ringDots(g, x, y, CONFIG.abilities.magnet.radius, 48, 3, COLOR.yellow, mine ? 0.5 : 0.3);
      }

      const slow = p.abilities.slow.activeMs;
      if (slow > 0 && (slow > 1500 || blink)) {
        this.ringDots(g, x, y, CONFIG.abilities.slow.radius, 64, 3, COLOR.slow, mine ? 0.5 : 0.3);
      }
    }
  }

  /** Energy bar and the four ability slots for your hero. Redrawn every frame; it is only a few rectangles. */
  protected drawHud(now: number): void {
    const g = this.hudGfx;
    g.clear();
    const me = this.me;

    // Energy bar: ten blocks, each worth a tenth of the maximum.
    const perBlock = CONFIG.energy.max / ENERGY_BAR.segments;
    const filled = Math.floor(me.energy / perBlock);
    for (let i = 0; i < ENERGY_BAR.segments; i++) {
      const x = ENERGY_BAR.x + i * (ENERGY_BAR.segmentWidth + ENERGY_BAR.gap);
      g.fillStyle(i < filled ? COLOR.cyan : COLOR.dim, i < filled ? 1 : 0.35);
      g.fillRect(x, ENERGY_BAR.y, ENERGY_BAR.segmentWidth, ENERGY_BAR.segmentHeight);
    }

    ABILITY_SLOTS.forEach((slot, i) => {
      const spec = CONFIG.abilities[slot.id];
      const ability = me.abilities[slot.id];
      const x = SLOT.x + i * (SLOT.width + SLOT.gap);
      const affordable = me.energy >= spec.cost;
      const ready = affordable && me.alive && ability.cooldownMs <= 0 && ability.activeMs <= 0;
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
  protected ringDots(
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

  /** A quick burst of little squares flying outwards, used for pickups, shield, bumps and teleport. */
  protected burst(x: number, y: number, color: number, count: number): void {
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

  /** Solid walls, and blinking outlines for new walls that are not solid yet. */
  protected drawBarriers(now: number): void {
    const g = this.barrierGfx;
    g.clear();
    const theme = THEMES[this.themeIndex];
    const fill = hex(theme.barrier);
    const edge = hex(theme.barrierEdge);
    const blink = Math.floor(now / 150) % 2 === 0;

    for (const b of this.state.barriers) {
      if (b.warningMs > 0) {
        g.fillStyle(fill, 0.25);
        g.fillRect(b.x, b.y, b.width, b.height);
        if (blink) {
          g.lineStyle(2, edge, 1);
          g.strokeRect(b.x + 1, b.y + 1, b.width - 2, b.height - 2);
        }
      } else {
        g.fillStyle(fill, 1);
        g.fillRect(b.x, b.y, b.width, b.height);
        g.lineStyle(2, edge, 1);
        g.strokeRect(b.x + 1, b.y + 1, b.width - 2, b.height - 2);
      }
    }
  }

  /** Floor dots and border, drawn in the current theme's colours. */
  protected drawArena(): void {
    const { arena } = CONFIG;
    const theme = THEMES[this.themeIndex];
    const g = this.arenaGfx;
    g.clear();

    // Dotted floor, like the reference pattern.
    g.fillStyle(hex(theme.floorDots), 1);
    for (let y = arena.y + 12; y < arena.y + arena.height; y += 24) {
      for (let x = arena.x + 12; x < arena.x + arena.width; x += 24) g.fillRect(x, y, 2, 2);
    }

    // Border, drawn just outside the playable area so sprites touch its inner edge.
    g.lineStyle(2, hex(theme.border), 1);
    g.strokeRect(arena.x - 1, arena.y - 1, arena.width + 2, arena.height + 2);
  }

  protected createHud(): void {
    const bg = this.add.graphics().setDepth(20);
    bg.fillStyle(COLOR.hud, 1);
    bg.fillRect(0, 0, CONFIG.screen.width, HUD_HEIGHT);
    bg.fillStyle(COLOR.line, 1);
    bg.fillRect(0, HUD_HEIGHT, CONFIG.screen.width, 2);
    this.hudGfx = this.add.graphics().setDepth(21);

    const mid = HUD_HEIGHT / 2;
    this.timeText = this.add
      .text(20, mid, '04:00', { fontFamily: FONT, fontSize: '16px', color: PALETTE.text })
      .setOrigin(0, 0.5)
      .setDepth(22);
    this.orbText = this.add
      .text(112, mid, 'ORB 0', { fontFamily: FONT, fontSize: '10px', color: PALETTE.yellow })
      .setOrigin(0, 0.5)
      .setDepth(22);
    this.add
      .text(ENERGY_BAR.x - 10, mid, 'EN', { fontFamily: FONT, fontSize: '10px', color: PALETTE.grey })
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
      this.hearts.push(this.add.image(heartsX + i * 30, mid, 'heart').setOrigin(0, 0.5).setDepth(22));
    }
  }

  protected createOverlay(): void {
    const { width, height } = CONFIG.screen;
    const dim = this.add.rectangle(0, 0, width, height, COLOR.hud, 0.86).setOrigin(0, 0);

    this.overlayTitle = this.add
      .text(width / 2, 110, '', { fontFamily: FONT, fontSize: '32px', color: PALETTE.cyan })
      .setOrigin(0.5);
    this.overlayBody = this.add
      .text(width / 2, 275, '', { fontFamily: FONT, fontSize: '12px', color: PALETTE.text, align: 'center', lineSpacing: 10 })
      .setOrigin(0.5);
    this.overlayPrompt = this.add
      .text(width / 2, 455, '', { fontFamily: FONT, fontSize: '16px', color: PALETTE.yellow })
      .setOrigin(0.5);

    this.tweens.add({ targets: this.overlayPrompt, alpha: 0.2, duration: 600, yoyo: true, repeat: -1 });

    this.overlay = this.add
      .container(0, 0, [dim, this.overlayTitle, this.overlayBody, this.overlayPrompt])
      .setDepth(30);
  }
}
