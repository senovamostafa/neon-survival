import { NAME_PATTERN, ROOM_CODE_PATTERN, type ClientMessage, type ServerMessage } from '../net/protocol';

/** Talking to the room server: a few web requests to make or check a room, then one WebSocket. */

/** Where the room server lives. Set VITE_SERVER_URL when building for the internet. */
export function serverBase(): string {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (configured) return configured.replace(/\/+$/, '');
  // While developing, the server runs on the same computer as the page.
  return `http://${window.location.hostname || 'localhost'}:8787`;
}

/** http://host -> ws://host/ws/CODE (and https -> wss). */
export function toWsUrl(base: string, code: string): string {
  return `${base.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws/${code}`;
}

export function cleanName(raw: string): string {
  return raw.trim();
}

export function nameProblem(raw: string): string | null {
  return NAME_PATTERN.test(cleanName(raw)) ? null : 'NAME: 3-12 LETTERS, DIGITS OR _';
}

export function cleanCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function codeProblem(raw: string): string | null {
  return ROOM_CODE_PATTERN.test(cleanCode(raw)) ? null : 'ROOM CODE IS 4 LETTERS';
}

/** Asks the server for a brand new room and returns its code. Throws a short message on failure. */
export async function createRoom(base: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/rooms`, { method: 'POST' });
  } catch {
    throw new Error('CANNOT REACH THE SERVER');
  }
  if (!response.ok) throw new Error('SERVER COULD NOT MAKE A ROOM');
  const body = (await response.json()) as { code?: unknown };
  if (typeof body.code !== 'string' || !ROOM_CODE_PATTERN.test(body.code)) throw new Error('SERVER SENT A BAD CODE');
  return body.code;
}

/** Does this room exist? Throws a short message if the server cannot be reached. */
export async function roomExists(base: string, code: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/rooms/${code}`);
  } catch {
    throw new Error('CANNOT REACH THE SERVER');
  }
  return response.ok;
}

export interface ConnectionHandlers {
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onClose(): void;
}

/** One WebSocket to one room. */
export class Connection {
  private readonly socket: WebSocket;

  constructor(url: string, handlers: ConnectionHandlers) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('open', () => handlers.onOpen());
    this.socket.addEventListener('close', () => handlers.onClose());
    this.socket.addEventListener('error', () => {
      // A failed connection also fires "close", which is where we react.
    });
    this.socket.addEventListener('message', (event) => {
      const message = parseServerMessage(event.data);
      if (message) handlers.onMessage(message);
    });
  }

  send(message: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close(1000, 'bye');
  }
}

/** Reads one server message. Anything that is not an object with a text "t" is ignored. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const data = JSON.parse(raw) as { t?: unknown } | null;
    return data && typeof data.t === 'string' ? (data as ServerMessage) : null;
  } catch {
    return null;
  }
}
