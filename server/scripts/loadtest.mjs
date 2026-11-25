// Load test for the room server: connects N fake players over real WebSockets,
// starts a match, makes everyone move around and use abilities, and measures what they receive.
//
//   npm run server:dev                      (in one terminal)
//   npm run server:loadtest                 (in another; defaults: 10 players, 30 seconds)
//   npm run server:loadtest -- --players 10 --seconds 60
//   npm run server:loadtest -- --server https://your-worker.workers.dev   (a deployed server)
//
// It needs Node 22 or newer (it uses the built-in WebSocket).

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return pairs;
  }, []),
);
const PLAYERS = Number(args.players ?? 10);
const SECONDS = Number(args.seconds ?? 30);
const SERVER = (args.server ?? 'http://localhost:8787').replace(/\/$/, '');
const WS_BASE = SERVER.replace(/^http/, 'ws');
const INPUT_HZ = 20;
/** When the first "results" message arrived, if the test ran long enough for the match to finish. */
let matchEndedAt = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

async function createRoom() {
  const reply = await fetch(`${SERVER}/api/rooms`, { method: 'POST' });
  if (!reply.ok) throw new Error(`could not create a room: ${reply.status}`);
  return (await reply.json()).code;
}

async function serverStats(code) {
  const reply = await fetch(`${SERVER}/api/rooms/${code}/stats`);
  return reply.ok ? reply.json() : null;
}

/** One fake player. */
function connect(code, name) {
  const player = {
    name,
    playerId: null,
    phase: 'lobby',
    snapshots: 0,
    bytes: 0,
    lastAt: null,
    gaps: [],
    orbs: 0,
    ws: new WebSocket(`${WS_BASE}/ws/${code}`),
    send(message) {
      if (player.ws.readyState === WebSocket.OPEN) player.ws.send(JSON.stringify(message));
    },
  };
  player.ready = new Promise((resolve, reject) => {
    player.ws.onopen = () => player.send({ t: 'join', name });
    player.ws.onerror = () => reject(new Error(`${name}: connection failed`));
    player.ws.onmessage = (event) => {
      const data = String(event.data);
      const message = JSON.parse(data);
      if (message.t === 'welcome') {
        player.playerId = message.playerId;
        resolve();
      } else if (message.t === 'room') {
        player.phase = message.phase;
      } else if (message.t === 'results') {
        player.results = message.ranking;
        // The match is over: from here on there is nothing left to measure.
        if (matchEndedAt === null) matchEndedAt = performance.now();
      } else if (message.t === 'error') {
        console.log(`  ${name}: server said ${message.code}`);
      } else if (message.t === 'snap') {
        const now = performance.now();
        if (player.lastAt !== null) player.gaps.push(now - player.lastAt);
        player.lastAt = now;
        player.snapshots++;
        player.bytes += data.length;
        player.orbs = message.players.find((p) => p.id === player.playerId)?.orbs ?? player.orbs;
      }
    };
  });
  return player;
}

async function main() {
  console.log(`Load test: ${PLAYERS} players for ${SECONDS} s against ${SERVER}`);
  const code = await createRoom();
  console.log(`Room ${code} created`);

  const players = Array.from({ length: PLAYERS }, (_, i) => connect(code, `Bot${String(i + 1).padStart(2, '0')}`));
  await Promise.all(players.map((p) => p.ready));
  console.log(`All ${PLAYERS} players joined`);

  players[0].send({ t: 'start' });
  const startedWaiting = performance.now();
  while (players.some((p) => p.phase !== 'playing')) {
    if (performance.now() - startedWaiting > 15_000) throw new Error('the match did not start in time');
    await sleep(50);
  }
  console.log('Match started (after the 5 s countdown). Playing...');

  const before = await serverStats(code);
  const playStart = performance.now();
  // Forget the countdown-phase gaps: only measure the match itself.
  for (const p of players) {
    p.gaps = [];
    p.snapshots = 0;
    p.bytes = 0;
    p.lastAt = null;
  }

  // Everyone walks around randomly and uses abilities now and then.
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [0, 0]];
  const heading = players.map(() => dirs[Math.floor(Math.random() * dirs.length)]);
  const abilities = ['shield', 'slow', 'teleport', 'magnet'];
  const driver = setInterval(() => {
    players.forEach((p, i) => {
      if (Math.random() < 0.08) heading[i] = dirs[Math.floor(Math.random() * dirs.length)];
      p.send({ t: 'input', dx: heading[i][0], dy: heading[i][1] });
      if (Math.random() < 0.01) p.send({ t: 'ability', id: abilities[Math.floor(Math.random() * 4)] });
    });
  }, 1000 / INPUT_HZ);

  await sleep(SECONDS * 1000);
  clearInterval(driver);
  // Measure only while the match was actually running. A 4-minute match ends by itself, so a test
  // that waits longer than that must not count the quiet time afterwards as "the server falling behind".
  const playSeconds = ((matchEndedAt ?? performance.now()) - playStart) / 1000;
  const after = await serverStats(code);

  // ---- report ----
  const rows = players.map((p) => {
    const gaps = [...p.gaps].sort((a, b) => a - b);
    return {
      hz: p.snapshots / playSeconds,
      p50: percentile(gaps, 50),
      p95: percentile(gaps, 95),
      p99: percentile(gaps, 99),
      max: gaps.at(-1) ?? 0,
      kbPerSec: p.bytes / 1024 / playSeconds,
      avgBytes: p.snapshots ? p.bytes / p.snapshots : 0,
    };
  });
  const avg = (key) => rows.reduce((sum, r) => sum + r[key], 0) / rows.length;
  const worst = (key) => Math.max(...rows.map((r) => r[key]));

  console.log('\n--- what the players received (each of the ' + PLAYERS + ') ---');
  console.log(`snapshots per second   avg ${avg('hz').toFixed(1)}   (target 20)`);
  console.log(`gap between snapshots  p50 ${avg('p50').toFixed(0)} ms   p95 ${avg('p95').toFixed(0)} ms   p99 ${avg('p99').toFixed(0)} ms   worst ${worst('max').toFixed(0)} ms`);
  console.log(`snapshot size          avg ${avg('avgBytes').toFixed(0)} bytes   download ${avg('kbPerSec').toFixed(1)} KB/s per player`);

  // How the gaps are spread out (all players together).
  const allGaps = players.flatMap((p) => p.gaps);
  const buckets = [['under 10 ms', 0, 10], ['10-40 ms', 10, 40], ['40-60 ms', 40, 60], ['60-80 ms', 60, 80], ['80-150 ms', 80, 150], ['over 150 ms', 150, Infinity]];
  console.log('gap spread             ' + buckets.map(([label, lo, hi]) => `${label}: ${((allGaps.filter((g) => g >= lo && g < hi).length / allGaps.length) * 100).toFixed(0)}%`).join('   '));

  if (before && after) {
    const steps = after.stepsRun - before.stepsRun;
    const expected = playSeconds * 60;
    console.log('\n--- what the server says about itself ---');
    console.log(`game steps run         ${steps} of about ${expected.toFixed(0)} expected  (${((steps / expected) * 100).toFixed(1)}%)`);
    console.log(`late ticks             ${after.lateTicks - before.lateTicks}  (a tick that came >40 ms after the last)`);
    console.log(`longest gap between ticks  ${after.maxTickGapMs.toFixed(0)} ms`);
    console.log(`largest snapshot       ${after.maxSnapshotBytes} bytes`);
    console.log(`messages received      ${after.messagesReceived}   dropped ${after.messagesDropped}`);
  }

  const orbs = players.map((p) => p.orbs);
  console.log(`\norbs collected by the random-walking bots: ${orbs.join(', ')}`);

  // Only if the test ran long enough for the 4-minute match to finish.
  const gotResults = players.filter((p) => p.results).length;
  if (gotResults > 0) {
    const table = players[0].results;
    console.log(`\nThe match finished: ${gotResults} of ${PLAYERS} players received the results.`);
    console.log('Top 3: ' + table.slice(0, 3).map((r) => `${r.rank}. ${r.name} (${r.orbs} orbs)`).join('   '));
    console.log('Ranks are all different: ' + (new Set(table.map((r) => r.rank)).size === table.length));
  }

  const stepsOk = !before || !after || (after.stepsRun - before.stepsRun) / (playSeconds * 60) > 0.97;
  const verdict = avg('hz') >= 18 && avg('p99') < 150 && stepsOk;
  console.log(verdict ? '\nRESULT: PASS - the server keeps up with this many players.' : '\nRESULT: FAIL - the server is falling behind.');

  for (const p of players) p.ws.close();
  await sleep(200);
  process.exit(verdict ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nLoad test could not run: ${error.message}`);
  console.error('Is the server running? Start it with: npm run server:dev');
  process.exit(2);
});
