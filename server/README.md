# The room server

This folder is the online part of Neon Survival: a Cloudflare Worker that creates rooms and a Durable Object that runs each room (lobby, countdown, the 4-minute match, results).

**The server decides everything.** Players only send which keys they press; the server runs the same game rules as the browser (`src/core`) and sends everyone the result 20 times a second. That is what makes the final ranking trustworthy.

## Run it on your computer

You do **not** need a Cloudflare account for this.

```powershell
npm install
npm run server:dev
```

It listens on http://127.0.0.1:8787. Check it works:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/rooms
```

The second command returns a room code such as `GPCR`.

## Load test (10 players)

With the server running in one terminal, in another:

```powershell
npm run server:loadtest                      # 10 players for 30 seconds
npm run server:loadtest -- --seconds 248     # a whole 4-minute match, including the results
npm run server:loadtest -- --players 6 --seconds 60
```

It connects real WebSocket players, starts a match, makes everyone walk around and use abilities, and prints how often snapshots arrive, how big they are, and whether the server kept up (it prints `RESULT: PASS` or `FAIL`).

## Quick check of the room rules

With the server running:

```powershell
npm run server:smoke
```

It checks names, host and countdown rules, reconnecting with the same name and watching a running match, over real sockets (16 checks).

## Tests

```powershell
npm test
```

`server/src/roomEngine.test.ts` tests the whole room (joining, host, countdown, snapshots, disconnects, results, abuse) with fake players and a fake clock, so a 4-minute match runs in about a second.

## How it fits together

```
src/net/protocol.ts       The messages between browser and server (shared with the client).
server/src/roomEngine.ts  The room's rules: lobby, countdown, match loop, snapshots. No Cloudflare code.
server/src/snapshot.ts    Builds the compact snapshot and the "what happened" event list.
server/src/room.ts        The Durable Object: sockets, timer, clean-up. Thin wrapper around the engine.
server/src/worker.ts      The front door: create room, room info, open a socket to a room.
server/wrangler.toml      Cloudflare settings.
server/scripts/loadtest.mjs  The load test.
```

### HTTP and WebSocket

| Request | What it does |
|---|---|
| `POST /api/rooms` | Makes a room, returns `{ "code": "ABCD" }` |
| `GET /api/rooms/ABCD` | `{ exists, phase, players, connections }`, or 404 if there is no such room |
| `GET /api/rooms/ABCD/stats` | Server-side numbers (late ticks, snapshot sizes...) used by the load test |
| `GET /api/health` | `{ ok: true }` |
| `GET /ws/ABCD` (WebSocket) | Join the room |

### Messages (JSON text over the WebSocket)

You send: `join {name}`, `start` (host), `input {dx, dy}`, `ability {id}`, `again` (host), `ping {ts}`.

You receive: `welcome`, `room` (who is in the room and which phase), `start`, `maze` (the walls), `snap` (the match, ~20 times a second), `ability` (answer to your ability request), `results`, `pong`, `error`. The exact shapes are in `src/net/protocol.ts`.

### Rules the server enforces

- Names are 3-12 letters, digits or underscores, and unique in the room (ignoring capitals). The same name coming back after a disconnect resumes that player.
- 3 to 10 players; only the host (first player in) can start, and only with at least 3 connected. If the host leaves, the next player becomes host.
- Nobody joins a match in progress: newcomers watch and join the next lobby.
- Every message is validated; input is forced to -1, 0 or 1; messages over 512 bytes are ignored; each connection is limited to about 60 messages per second.
- A player who stops sending input stands still after 0.6 s. A disconnected hero disappears after 10 s but keeps its orbs.
- An empty room is forgotten after 10 minutes.

## Putting it on the internet (later, Phase 8)

Running on Cloudflare needs a free account. When we get there the steps are:

1. Create a free account at https://dash.cloudflare.com/sign-up.
2. `npx wrangler login` (opens a browser to approve).
3. `npx wrangler deploy --config server/wrangler.toml`
4. Set `ALLOWED_ORIGINS` in `server/wrangler.toml` to your game's address so other websites cannot use your server.

Free plan limits to keep in mind: 100,000 requests a day (incoming WebSocket messages count 20 to 1; outgoing are free) and 13,000 GB-seconds a day of room running time. One 10-player match costs very roughly 2,400 request-equivalents, so a day allows many matches. If a limit is hit, rooms fail until 00:00 UTC.
