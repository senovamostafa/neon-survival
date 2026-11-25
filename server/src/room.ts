import { DurableObject } from 'cloudflare:workers';
import { RoomEngine } from './roomEngine';

/** The settings the Worker is given (see wrangler.toml). */
export interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
  ALLOWED_ORIGINS: string;
}

/**
 * How often the room's clock ticks. The game itself runs at exactly 60 steps a second whatever
 * this is (it catches up), but a finer tick makes snapshots go out at steadier times. Some
 * computers (Windows) round timers up to about 16 ms, so we ask for less than that.
 */
const TICK_MS = 10;
/** An empty room is forgotten after this long, so rooms do not pile up. */
const EMPTY_ROOM_MS = 10 * 60 * 1000;
/** A lobby nobody has touched for this long is closed. */
const IDLE_LOBBY_MS = 30 * 60 * 1000;

/**
 * One game room. Cloudflare creates exactly one of these per room code and routes every player of
 * that room to it, so all the players share one running game.
 *
 * This class only handles the Cloudflare parts: accepting sockets, running the timer, and cleaning
 * up. All the game and lobby logic is in RoomEngine, which is tested separately.
 */
export class GameRoom extends DurableObject<Env> {
  private engine: RoomEngine | null = null;
  private readonly sockets = new Map<string, WebSocket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextConn = 1;
  private lastActivityAt = Date.now();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = request.headers.get('x-room-code') ?? '';

    if (url.pathname === '/create') {
      // Reserve this code. If it is already taken the Worker picks another one.
      if (await this.ctx.storage.get('created')) return new Response('taken', { status: 409 });
      await this.ctx.storage.put('created', true);
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_MS);
      return new Response('created', { status: 201 });
    }

    if (!(await this.ctx.storage.get('created'))) return new Response('no such room', { status: 404 });

    if (url.pathname === '/info') {
      const engine = this.getEngine(code);
      return Response.json({
        exists: true,
        phase: engine.currentPhase,
        players: engine.playerCount,
        connections: engine.connectionCount,
      });
    }
    if (url.pathname === '/stats') return Response.json(this.getEngine(code).stats);
    if (url.pathname === '/ws') return this.acceptSocket(request, code);

    return new Response('not found', { status: 404 });
  }

  private getEngine(code: string): RoomEngine {
    this.engine ??= new RoomEngine(code, {
      send: (id, data) => {
        try {
          this.sockets.get(id)?.send(data);
        } catch {
          // The socket is closing; its close event will clean up.
        }
      },
      close: (id) => this.sockets.get(id)?.close(1000, 'bye'),
    });
    return this.engine;
  }

  private acceptSocket(request: Request, code: string): Response {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });

    const engine = this.getEngine(code);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const id = `c${this.nextConn++}`;
    this.sockets.set(id, server);
    this.lastActivityAt = Date.now();
    void this.ctx.storage.deleteAlarm(); // someone is here, do not clean the room up
    engine.connect(id);
    this.startTimer();

    server.addEventListener('message', (event) => {
      this.lastActivityAt = Date.now();
      engine.message(id, event.data);
    });
    const gone = (): void => {
      if (!this.sockets.delete(id)) return;
      engine.disconnect(id);
      if (this.sockets.size === 0) this.becameEmpty();
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- the clock -----------------------------------------------------------

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      const engine = this.engine;
      if (!engine) return;
      engine.tick(Date.now());

      // Close a lobby that has been sitting idle for ages.
      if (engine.currentPhase === 'lobby' && Date.now() - this.lastActivityAt > IDLE_LOBBY_MS) {
        for (const socket of this.sockets.values()) socket.close(1000, 'idle');
      }
    }, TICK_MS);
  }

  private becameEmpty(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // Forget the room if nobody comes back in a while (see alarm below).
    void this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_MS);
  }

  /** Runs when the room has been empty for a while: forget it, so its code can be reused. */
  async alarm(): Promise<void> {
    if (this.sockets.size > 0) return;
    this.engine = null;
    await this.ctx.storage.deleteAll();
  }
}
