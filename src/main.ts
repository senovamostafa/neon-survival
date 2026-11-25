import Phaser from 'phaser';
import { CONFIG } from './core/config';
import { GameScene } from './game/GameScene';
import { OnlineScene } from './game/OnlineScene';
import { PALETTE } from './game/sprites';
import { OnlineApp } from './online/app';
import { Screens } from './ui/screens';

/** Wait briefly for the pixel font so the first screen does not flash a fallback font. */
async function waitForFont(): Promise<void> {
  try {
    await Promise.race([
      document.fonts.load('16px "Press Start 2P"'),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // Offline or blocked: the monospace fallback is fine.
  }
}

async function boot(): Promise<void> {
  // Touch devices only see the "play on a computer" notice from index.html.
  if (window.matchMedia('(pointer: coarse)').matches) return;

  await waitForFont();

  // "?local" plays the old offline match against bots (handy for testing without a server).
  const offline = new URLSearchParams(window.location.search).has('local');
  const app = new OnlineApp();
  const ui = document.getElementById('ui');
  if (offline) ui?.remove();
  else if (ui) new Screens(ui, app);

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: CONFIG.screen.width,
    height: CONFIG.screen.height,
    backgroundColor: PALETTE.background,
    pixelArt: true, // nearest-neighbour scaling keeps the pixels sharp
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [offline ? GameScene : OnlineScene],
    callbacks: { preBoot: (game) => game.registry.set('app', app) },
  });
}

void boot();
