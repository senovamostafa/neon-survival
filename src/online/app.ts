import type { AbilityId } from '../core/types';
import {
  cleanCode,
  cleanName,
  codeProblem,
  Connection,
  createRoom,
  nameProblem,
  roomExists,
  serverBase,
  toWsUrl,
} from './connection';
import { InputSender } from './inputSender';
import { OnlineSession } from './session';

/**
 * The online game's controller: owns the connection and the session, and is the one thing the
 * screens (HTML) and the arena (Phaser) both talk to. It holds no rules.
 */

const PING_EVERY_MS = 2000;
const now = (): number => performance.now();

export class OnlineApp {
  readonly session = new OnlineSession();
  readonly input = new InputSender();
  /** A short message for the title screen ("ROOM NOT FOUND"). */
  notice = '';
  /** True while we are waiting for the server (disables the buttons). */
  busy = false;

  private connection: Connection | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();

  /** Called whenever the screen should be redrawn (room changed, notice changed...). */
  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  get connected(): boolean {
    return this.connection !== null;
  }

  // ---- the title screen's three actions -------------------------------------

  async createRoomAndJoin(rawName: string): Promise<void> {
    const problem = nameProblem(rawName);
    if (problem) return this.fail(problem);
    await this.guard(async () => {
      const code = await createRoom(serverBase());
      this.open(code, cleanName(rawName));
    });
  }

  async joinRoom(rawName: string, rawCode: string): Promise<void> {
    const problem = nameProblem(rawName) ?? codeProblem(rawCode);
    if (problem) return this.fail(problem);
    const code = cleanCode(rawCode);
    await this.guard(async () => {
      if (!(await roomExists(serverBase(), code))) throw new Error('ROOM NOT FOUND');
      this.open(code, cleanName(rawName));
    });
  }

  leave(): void {
    this.close();
    this.session.reset();
    this.notice = '';
    this.emit();
  }

  // ---- in the lobby and in the match -----------------------------------------

  start(): void {
    this.connection?.send({ t: 'start' });
  }

  playAgain(): void {
    this.connection?.send({ t: 'again' });
  }

  useAbility(id: AbilityId): void {
    this.connection?.send({ t: 'ability', id });
  }

  /** Tells the server which keys are held (only when something changed or as a heartbeat). */
  sendInput(dx: number, dy: number): void {
    const message = this.input.next(dx, dy, now());
    if (message) this.connection?.send({ t: 'input', dx: message.dx, dy: message.dy });
  }

  // ---- plumbing ---------------------------------------------------------------

  private open(code: string, name: string): void {
    this.close();
    this.session.reset();
    this.input.reset();

    const connection = new Connection(toWsUrl(serverBase(), code), {
      onOpen: () => {
        connection.send({ t: 'join', name });
        this.pingTimer = setInterval(() => connection.send({ t: 'ping', ts: now() }), PING_EVERY_MS);
      },
      onMessage: (message) => {
        if (this.connection !== connection) return;
        this.session.apply(message, now());
        if (message.t === 'error' && !this.session.room) {
          // We never got into the room (bad name, name taken, room full): back to the title screen.
          this.notice = message.message.toUpperCase();
          this.close();
        }
        if (message.t !== 'snap' && message.t !== 'pong') this.emit(); // snapshots are drawn by the arena
      },
      onClose: () => {
        if (this.connection !== connection) return;
        const wasInRoom = this.session.room !== null;
        this.close();
        this.session.reset();
        if (wasInRoom && !this.notice) this.notice = 'CONNECTION LOST';
        this.emit();
      },
    });
    this.connection = connection;
    this.notice = '';
  }

  private close(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const connection = this.connection;
    this.connection = null; // first, so its "close" event is ignored
    connection?.close();
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.notice = '';
    this.emit();
    try {
      await action();
    } catch (error) {
      this.notice = error instanceof Error ? error.message : 'SOMETHING WENT WRONG';
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private fail(message: string): void {
    this.notice = message;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
