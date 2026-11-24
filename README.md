# Neon Survival

An endless retro-pixel arcade survival game for the browser. Dodge the invaders, survive as long as you can.

**Status: Phase 1 (game foundation)** - arena, player movement, collision, three lives, one bouncing test hazard, game over and Play Again. Energy, abilities, arena events, nicknames and the leaderboard come in later phases.

## Run it

You need Node.js 20 or newer (check with `node -v`).

```powershell
npm install
npm run dev
```

Open the address it prints (normally http://localhost:5173). Click the game once, press **Space** to start, move with **WASD** or the **arrow keys**.

Other commands:

```powershell
npm test          # run the unit tests once
npm run test:watch  # re-run tests whenever you save
npm run typecheck # TypeScript check without building
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

## How the code is organised

```
src/
  core/        Game rules in plain TypeScript. No Phaser, no browser.
    config.ts    Every tunable number (speeds, lives, sizes). Change balance here.
    game.ts      createGame / startRun / stepGame: the actual rules.
    rng.ts       Seeded random numbers (same seed = same run, great for tests).
    collision.ts Circle and rectangle overlap checks.
    stepper.ts   Turns frame times into fixed 60 Hz simulation steps.
    format.ts    Survival time as MM:SS.
    core.test.ts Unit tests for all of the above.
  game/        Phaser: reads the keyboard, calls core, draws the result.
    GameScene.ts The only scene. Holds no game rules.
    sprites.ts   Pixel sprites drawn from text bitmaps, and the colour palette.
  main.ts      Starts Phaser.
index.html     Page shell, pixel font, "play on a computer" notice for touch devices.
```

Why the split: the rules in `core/` never touch Phaser, so they are fast to test and the game behaves identically on 60 Hz and 144 Hz monitors (fixed timestep).

## Troubleshooting

- **`npm` is not recognised**: install Node.js from https://nodejs.org and reopen PowerShell.
- **Port 5173 already in use**: stop the other dev server, or run `npm run dev -- --port 5174`.
- **Pixel font looks like plain monospace**: the font loads from Google Fonts, so it needs internet. The game still works without it.
- **Keys do nothing**: click the game area once so the page has keyboard focus.
- **Blank page in a hidden or background tab**: browsers pause animation in hidden tabs. Bring the tab to the front.

## Roadmap

1. Game foundation (this phase)
2. Survival mechanics: obstacle types, energy orbs, four abilities
3. Endless gameplay: random generation, arena events, difficulty curve
4. Backend: Supabase tables, nickname-only players, run submission
5. Competition: personal best, all-time and weekly leaderboards, profile
6. Polish and deployment: chiptune sound, GitHub Pages

Decisions for the later phases: Supabase (hosted Postgres) is called directly from the browser, so there is no custom server. Players log in with a nickname only, and scores are submitted by the client without anti-cheat. This is a deliberate trade-off for a small portfolio game.
