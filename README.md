# Neon Survival

An endless retro-pixel arcade survival game for the browser. Dodge the invaders, survive as long as you can.

**Status: Phase 3 (endless gameplay)** - the game is now endless: difficulty rises with survival time, random arena events, and the arena transforms every minute. Sound, nicknames and the leaderboard come in later phases.

## How to play

- **Move:** WASD or arrow keys. **Start / play again:** Space.
- **Orbs** (yellow diamonds) give +10 energy. They never add to your score; the score is survival time only.
- **Abilities** (cost energy, shown in the top bar):

| Key | Ability | Cost | What it does |
|---|---|---|---|
| 1 | Shield | 40 | Absorbs one hit, or lasts 6 s |
| 2 | Slow | 30 | Moving obstacles at 40% speed for 5 s |
| 3 | Warp | 25 | Teleport to a random safe spot |
| 4 | Magnet | 20 | Pulls orbs within 140 px for 6 s |

- **Moving obstacles** (invaders) appear at an edge as a blinking marker with direction dots, then fly across.
- **Blue walls** block you but not the invaders. **Red circles** are traps: harmless while blinking, deadly once solid.
- All numbers live in `src/core/config.ts`.

### Difficulty and the endless arena

| Survival time | Stage | New obstacle about every | Obstacle speed |
|---|---|---|---|
| 0 s | Easy | 2.0 s | 60-100 px/s |
| 30 s | Medium | 1.4 s | 80-140 px/s |
| 90 s | Hard | 0.9 s | 110-190 px/s |
| 180 s+ | Extreme (capped) | 0.6 s | 140-240 px/s |

Values blend smoothly between these rows, so it gets harder gradually rather than in jumps. The stage also controls how many obstacles and traps can exist at once, and from 30 s on, obstacles sometimes arrive as a wave of 2-3 side by side (each starts a little later, leaving gaps).

**Random arena events** - one at a time, first one after 30-45 s, then every 25-45 s. Each shows a 3-second warning banner before it starts:

- **Gravity shift:** a steady 70 px/s push in the announced direction for 8 s. You can always fight it (you move at 180).
- **Blackout:** the arena goes dark for 7 s but you always see a 100 px circle around you.
- **Shrinking arena:** the walls close in (the warning outlines where they will stop) to 55% of the arena, hold, then open again. It never gets smaller than that.

During a blackout or shrink, obstacles spawn 1.5x less often to keep things fair.

**Sectors:** every 60 s the arena transforms. The colour theme changes, the old walls disappear, and a new set (one more wall each time, up to 7) fades in as blinking outlines that turn solid after 2 s. A new wall waits if you are standing where it would appear.

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
    config.ts    Every tunable number (speeds, costs, timings). Change balance here.
    types.ts     Data shapes: GameState, Drifter, Trap, Orb, abilities...
    game.ts      createGame / startRun / stepGame: the main rules loop.
    spawn.ts     Where things appear (fair, controlled randomness) and safe teleport spots.
    difficulty.ts Difficulty for a given survival time (blends the table in config.ts).
    events.ts    Gravity shift, blackout and shrinking arena: scheduling and effects.
    abilities.ts activateAbility: energy cost, cooldown and effect of each ability.
    rng.ts       Seeded random numbers (same seed = same run, great for tests).
    collision.ts Circle/rectangle overlap and wall push-out.
    stepper.ts   Turns frame times into fixed 60 Hz simulation steps.
    format.ts    Survival time as MM:SS.
    testUtils.ts Helpers for tests (an empty "quiet" game).
    core.test.ts Tests: movement, lives, collision, timestep.
    world.test.ts Tests: walls, obstacles, traps, orbs, abilities, determinism.
    progression.test.ts Tests: difficulty curve, waves, events, sectors, fairness fuzzing.
  (src/game/themes.ts holds the colour themes used for each sector.)
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

1. Game foundation (done)
2. Survival mechanics: obstacle types, energy orbs, four abilities (done)
3. Endless gameplay: random generation, arena events, difficulty curve (done; sound effects come in phase 6)
4. Backend: Supabase tables, nickname-only players, run submission
5. Competition: personal best, all-time and weekly leaderboards, profile
6. Polish and deployment: chiptune sound, GitHub Pages

Decisions for the later phases: Supabase (hosted Postgres) is called directly from the browser, so there is no custom server. Players log in with a nickname only, and scores are submitted by the client without anti-cheat. This is a deliberate trade-off for a small portfolio game.
