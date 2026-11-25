# Neon Survival

A retro-pixel arcade game for the browser. **3 to 10 players share one arena for 4 minutes and race for energy orbs. The player with the most orbs wins.**

**Play it now: https://senovamostafa.github.io/neon-survival/**  (on a computer with a keyboard; share the link and a room code with friends)

**Status: Phase 6 of 8 (online client).** You can now play online on your own computer: a pixel-styled title screen, lobby (room code, player list, host starts), the arena with every player's name, and a results screen, all talking to the room server. Deploying it to the internet and sound come in Phase 8.

## Run it

You need Node.js 20 or newer (check with `node -v`).

```powershell
npm install
npm run dev
```

Open the address it prints (normally http://localhost:5173).

### Play online (on one computer, with friends on the same network or in several tabs)

You need two PowerShell windows, one for the room server and one for the page:

```powershell
npm run server:dev   # the room server, on port 8787 (leave it running)
npm run dev          # the page, on port 5173
```

Open http://localhost:5173, type a nickname (3-12 letters, digits or `_`) and press **CREATE A ROOM**. Share the 4-letter code; friends type it under **JOIN**. A match needs at least 3 players; the host presses **START MATCH**. To try it alone, open the page in 3 browser tabs (use a different nickname in each).

If the server is somewhere else, build with `VITE_SERVER_URL` set, e.g. `$env:VITE_SERVER_URL="https://my-server.example.com"; npm run build`.

**Offline practice** (you against three bots, no server needed): open http://localhost:5173/?local and press **Space**.

Other commands:

```powershell
npm test            # run the unit tests once
npm run test:watch  # re-run tests whenever you save
npm run typecheck   # TypeScript check without building
npm run build       # production build into dist/
npm run preview     # serve the production build locally
```

## How to play

- **Move:** WASD or arrow keys. **Start / play again (offline mode):** Space.
- **Goal:** collect more yellow orbs than anyone else before the 4:00 clock runs out. Ties go to whoever reached their final count first.
- Orbs are shared: the first player to touch one takes it. Each orb is +1 score and +10 energy. Spending energy never lowers your score.
- **Abilities** (cost energy, shown in the top bar):

| Key | Ability | Cost | What it does |
|---|---|---|---|
| 1 | Shield | 40 | Absorbs one hit, or lasts 6 s |
| 2 | Slow | 30 | Obstacles within 200 px of you move at 40% speed for 5 s |
| 3 | Warp | 25 | Teleport to a random safe spot |
| 4 | Magnet | 20 | Pulls orbs within 140 px toward you for 6 s (it can steal from rivals) |

- **Lives:** you start with 3. Touch an obstacle and you lose one. Lose them all and you are frozen for 5 s, then come back with 1 life, 2 s of protection and 0 energy. Your orbs are kept.
- **Bumping:** two players who touch are shoved straight apart (about 50 px each). It does no damage, but walls still stop the shove, so a bump can push you toward danger.
- **The arena is a maze** of corridors about 42 px wide. It has loops and no dead ends, so nobody can get cornered. **Walls** block players. **Enemies** (invaders) appear in a corridor as a blinking marker with direction dots, then fly straight along it, and **vanish when they hit a wall**, so walls are also cover.
- All numbers live in `src/core/config.ts`.

### Difficulty and the endless arena

| Match time | Stage | New enemy about every | Enemy speed |
|---|---|---|---|
| 0 s | Easy | 4.2 s | 55-90 px/s |
| 30 s | Medium | 3.4 s | 70-115 px/s |
| 90 s | Hard | 2.7 s | 90-150 px/s |
| 180 s+ | Extreme (capped) | 2.1 s | 115-185 px/s |

Values blend smoothly between these rows. The stage also controls how many enemies (3 to 6) can exist at once, and from 30 s on, enemies sometimes arrive as a wave of 2-3 at once in different corridors (5% to 12% of spawns).

**Bigger rooms get more:** orbs appear at about one per player every 5 s (at least the 3-player rate), with up to 4 per player lying around, and enemy counts grow 5% for each player above 3.

**Sectors:** every 60 s the arena transforms. The colour theme changes and a brand new maze replaces the old one, with fewer openings each time (so it gets tighter). The new walls fade in as blinking outlines that turn solid after 2 s, and a wall waits if someone is standing where it would appear. Orbs that would end up inside the new walls are removed.

## How the code is organised

```
src/
  core/        The game rules in plain TypeScript. No Phaser, no browser: the same code
               will run in the browser and on the game server.
    config.ts      Every tunable number. Change balance here.
    types.ts       Data shapes: GameState, Player, Drifter, Orb, StepResult...
    game.ts        createMatch / startRun / stepGame: the main rules loop.
    players.ts     Starting spots, deaths and respawns, bumping, disconnects.
    roster.ts      Small helpers: who is active, present, frozen.
    maze.ts        Builds the maze (loops, no dead ends), its walls, and routes through it.
    spawn.ts       Where enemies and orbs appear (in corridors) and safe spots.
    abilities.ts   activateAbility: energy cost, cooldown and effect of each ability.
    difficulty.ts  Difficulty for a given match time (blends the table in config.ts).
    ranking.ts     Final standings and tie-breaks.
    bots.ts        Computer-controlled players (local play, tests, later load tests).
    rng.ts         Seeded random numbers (same seed = same match).
    collision.ts   Circle/rectangle overlap and wall push-out.
    movement.ts    moveHero: how a hero walks. Used by the server AND by the browser's prediction.
    stepper.ts     Turns frame times into fixed 60 Hz simulation steps.
    format.ts      Time as MM:SS.
    testUtils.ts   Helpers for tests (an empty "quiet" game).
    *.test.ts      Unit tests (core, world, progression, multiplayer).
  game/        Phaser: reads the keyboard, draws the arena. No game rules.
    GameScene.ts   The offline match (you + bots) and ALL the arena drawing code.
    OnlineScene.ts The online arena: the same drawing, fed from the server's snapshots.
    sprites.ts     Pixel sprites drawn from text bitmaps, hero colours, palette.
    themes.ts      Arena colour themes, one per sector.
  main.ts      Starts Phaser and the HTML screens.
  net/         Messages between browser and server (protocol.ts), shared by both.
  online/      The browser side of online play, in plain TypeScript (all tested without a browser).
    connection.ts    Room web requests and the WebSocket; name and room-code checks.
    session.ts       Everything we know about the room, built from server messages.
    interpolation.ts Smooths other players between the 20-per-second snapshots.
    prediction.ts    Moves your own hero at once with core/movement.ts, then corrects it gently.
    view.ts          Turns server snapshots into a picture the drawing code understands.
    inputSender.ts   Decides when to tell the server which keys are held.
    app.ts           Ties it together for the screens and the arena.
  ui/          The title, lobby and results screens as plain HTML (styles in index.html).
index.html     Page shell, pixel font, "play on a computer" notice for touch devices.
server/        The room server (Cloudflare Worker + Durable Object). See server/README.md.
```

Why the split: the rules in `core/` never touch Phaser, so they are fast to test, behave identically on 60 Hz and 144 Hz monitors (fixed timestep), and can be reused unchanged by the server.

## Troubleshooting

- **`npm` is not recognised**: install Node.js from https://nodejs.org and reopen PowerShell.
- **Port 5173 already in use**: stop the other dev server, or run `npm run dev -- --port 5174`.
- **Pixel font looks like plain monospace**: the font loads from Google Fonts, so it needs internet. The game still works without it.
- **Keys do nothing**: click the game area once so the page has keyboard focus.
- **"CANNOT REACH THE SERVER"**: start the room server first (`npm run server:dev`) and check it says it is listening on port 8787.
- **Hero feels slightly rubbery**: your own hero is moved at once and the server nudges it back when they disagree (for example after being bumped). That is expected.
- **Blank page in a hidden or background tab**: browsers pause animation in hidden tabs. Bring the tab to the front.

## Roadmap

1. Game foundation (done)
2. Survival mechanics: enemies, walls, orbs, four abilities (done; walls later became a maze)
3. Endless gameplay: difficulty curve and arena sectors (done; the traps and the gravity, blackout and shrinking-arena events were later removed to keep it lighter)
4. Multiplayer game core: N players, bumping, contested orbs, respawns, 4-minute match, ranking, bots (done)
5. **Realtime server: a Cloudflare Worker with one Durable Object per room, lobby and countdown, server game loop, state snapshots, 10-player load test (done; runs locally, deploy comes in phase 8)**
6. **Online client: pixel title, lobby and results screens, names in the arena, smoothing of other players, own-player prediction (done; runs locally)**
7. Persistence: D1 database, nickname-only players, wins and best-orb-count leaderboards (all-time and weekly)
8. Polish and deployment: chiptune sound, performance and browser testing, deploy to Cloudflare

Decisions for the online phases: one shared arena per room, run by an authoritative server that uses the same `core/` code. Rooms are private (share a link), the host starts the match once at least 3 players are in (maximum 10). Everything runs on Cloudflare (Pages, Workers with Durable Objects, D1). Players are identified by nickname only, with no anti-cheat beyond the server being in charge of the result.
