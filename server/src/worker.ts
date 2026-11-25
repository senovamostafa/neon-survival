import { ROOM_CODE_PATTERN } from '../../src/net/protocol';
import { GameRoom, type Env } from './room';

// Cloudflare needs the Durable Object class to be exported from the main file.
export { GameRoom };

/** Letters used in room codes. I and O are left out because they look like 1 and 0. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

/** Is this website allowed to talk to the server? Set ALLOWED_ORIGINS in wrangler.toml. */
function originAllowed(request: Request, env: Env): boolean {
  if (env.ALLOWED_ORIGINS === '*') return true;
  const origin = request.headers.get('Origin');
  return origin !== null && env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).includes(origin);
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers, webSocket: response.webSocket });
}

function roomStub(env: Env, code: string): DurableObjectStub<GameRoom> {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

/** Passes a request on to the room, telling it which code it is. */
function toRoom(env: Env, code: string, path: string, request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('x-room-code', code);
  return roomStub(env, code).fetch(new Request(`https://room${path}`, { method: request.method, headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (url.pathname === '/api/health') return withCors(Response.json({ ok: true }), request);
    if (!originAllowed(request, env)) return new Response('forbidden', { status: 403 });

    // POST /api/rooms -> a new room and its code
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = randomCode();
        const reply = await toRoom(env, code, '/create', request);
        if (reply.status === 201) return withCors(Response.json({ code }, { status: 201 }), request);
      }
      return withCors(Response.json({ error: 'could not make a room' }, { status: 503 }), request);
    }

    // GET /api/rooms/ABCD (and /stats) -> does this room exist, and what is in it?
    const info = url.pathname.match(/^\/api\/rooms\/([A-Za-z]{4})(\/stats)?$/);
    if (info && request.method === 'GET') {
      const code = info[1].toUpperCase();
      const reply = await toRoom(env, code, info[2] ? '/stats' : '/info', request);
      return withCors(reply.status === 404 ? Response.json({ exists: false }, { status: 404 }) : reply, request);
    }

    // GET /ws/ABCD (websocket) -> join the room
    const socket = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (socket) {
      const code = socket[1].toUpperCase();
      if (!ROOM_CODE_PATTERN.test(code)) return new Response('bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
      return toRoom(env, code, '/ws', request);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
