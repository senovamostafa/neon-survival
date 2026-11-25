// Checks the room rules over real WebSockets against a running server: names, host, countdown,
// reconnecting with the same name, watching a match in progress.
//
//   npm run server:dev       (in one terminal)
//   npm run server:smoke     (in another)
//
// It needs Node 22 or newer (it uses the built-in WebSocket).
const SERVER = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS_BASE = SERVER.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (label, ok) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + label); };

function client() {
  const c = { msgs: [], ws: null };
  c.open = (code) => new Promise((res, rej) => {
    c.ws = new WebSocket(`${WS_BASE}/ws/${code}`);
    c.ws.onopen = res; c.ws.onerror = () => rej(new Error('ws error'));
    c.ws.onmessage = (e) => c.msgs.push(JSON.parse(String(e.data)));
  });
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.last = (t) => c.msgs.filter((m) => m.t === t).at(-1);
  c.all = (t) => c.msgs.filter((m) => m.t === t);
  return c;
}

const { code } = await (await fetch(`${SERVER}/api/rooms`, { method: 'POST' })).json();
console.log('room', code);

// lowercase code works for the websocket too, and a made-up room is refused
const ghost = client();
let refused = false;
try { await ghost.open('QQQQ'); } catch { refused = true; }
check('socket to a room that does not exist is refused', refused);

const [a, b, c, d] = [client(), client(), client(), client()];
await a.open(code.toLowerCase()); await b.open(code); await c.open(code); await d.open(code);

a.send({ t: 'join', name: 'x' });
await sleep(100);
check('a too-short name gets a bad-name error', a.last('error')?.code === 'bad-name');

a.send({ t: 'join', name: 'Alice' }); b.send({ t: 'join', name: 'Bobby' });
await sleep(100);
d.send({ t: 'join', name: 'alice' });
await sleep(100);
check('a duplicate name (different capitals) is refused', d.last('error')?.code === 'name-taken');

a.send({ t: 'start' });
await sleep(100);
check('starting with 2 players is refused', a.last('error')?.code === 'not-enough-players');

c.send({ t: 'join', name: 'Carol' });
await sleep(100);
b.send({ t: 'start' });
await sleep(100);
check('a non-host cannot start', b.last('error')?.code === 'not-host');
check('the host is the first player in', a.last('room')?.hostId === a.last('welcome')?.playerId);

a.send({ t: 'start' });
await sleep(300);
check('the countdown begins', c.last('room')?.phase === 'countdown');
await sleep(5200);
check('the match starts after about 5 seconds', c.last('room')?.phase === 'playing' && !!c.last('start') && !!c.last('maze'));
check('snapshots are arriving', c.all('snap').length > 3);

// someone drops and comes back with the same name
const snapsBefore = b.all('snap').length;
b.ws.close();
await sleep(1500);
const b2 = client();
await b2.open(code);
b2.send({ t: 'join', name: 'bobby' });
await sleep(500);
check('the same name resumes the same player', b2.last('welcome')?.playerId === b.last('welcome')?.playerId && b2.last('welcome')?.spectating === false);
check('and is brought up to date with the match', !!b2.last('start') && !!b2.last('maze'));
await sleep(500);
check('and receives snapshots again', b2.all('snap').length > 3 && snapsBefore > 0);

// a newcomer during the match can only watch
const w = client();
await w.open(code);
w.send({ t: 'join', name: 'Watcher' });
await sleep(500);
check('a newcomer during a match is a spectator', w.last('welcome')?.spectating === true);
check('who still sees the match', w.all('snap').length > 3);

// d (never joined) can still just sit there; moving before joining is refused
d.send({ t: 'input', dx: 1, dy: 0 });
await sleep(100);
check('input before joining is refused', d.all('error').some((e) => e.code === 'not-joined'));

// the room reports itself
const info = await (await fetch(`${SERVER}/api/rooms/${code}`)).json();
check('room info shows a match in progress with 3 players', info.phase === 'playing' && info.players === 3);

for (const x of [a, b2, c, d, w]) x.ws.close();
await sleep(300);
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
