import { HERO_PALETTE } from '../game/sprites';
import type { OnlineApp } from '../online/app';
import type { RoomMember } from '../net/protocol';

/**
 * The full-page screens around the arena (title, lobby, results), as plain HTML in the game's
 * pixel font. Phaser draws only the arena; everything people click or type lives here.
 * Styles are in index.html (the #ui block).
 */

const NAME_KEY = 'neon-survival-name';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, disabled = false, className = ''): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function readSavedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private mode: not remembering the name is fine.
  }
}

/** Draws the right screen into `root` and keeps it up to date as the app changes. */
export class Screens {
  private shown = '';
  private countdownEl: HTMLElement | null = null;
  private noticeEl: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly app: OnlineApp,
  ) {
    app.onChange(() => this.render());
    setInterval(() => this.tickCountdown(), 200);
    this.render();
  }

  render(): void {
    const { session } = this.app;
    const screen = session.screen;
    // The title screen keeps its text boxes between redraws, so a notice never wipes what you typed.
    if (screen === 'title' && this.shown === 'title' && this.noticeEl) {
      this.noticeEl.textContent = this.app.notice;
      this.setBusy(this.app.busy);
      return;
    }
    this.shown = screen;

    this.root.replaceChildren();
    this.countdownEl = null;
    this.noticeEl = null;
    this.root.className = screen === 'playing' ? 'ui-off' : screen === 'results' ? 'ui-dim' : 'ui-solid';

    switch (screen) {
      case 'title':
        this.root.append(this.titleScreen());
        break;
      case 'lobby':
        this.root.append(this.lobbyScreen());
        break;
      case 'results':
        this.root.append(this.resultsScreen());
        break;
      case 'playing':
        if (session.spectating) this.root.append(el('div', 'spectate', 'WATCHING - YOU JOIN THE NEXT ROUND'));
        break;
    }
    this.tickCountdown();
  }

  // ---- title ------------------------------------------------------------------

  private titleScreen(): HTMLElement {
    const box = el('div', 'panel');
    box.append(el('h1', '', 'NEON SURVIVAL'));
    box.append(el('p', 'sub', 'RACE FOR ORBS - 4 MINUTES - 3 TO 10 PLAYERS'));

    const nameLabel = el('label', '', 'YOUR NAME');
    const nameInput = el('input');
    nameInput.maxLength = 12;
    nameInput.value = readSavedName();
    nameInput.placeholder = 'NICKNAME';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameLabel.append(nameInput);

    const create = button('CREATE A ROOM', () => {
      saveName(nameInput.value.trim());
      void this.app.createRoomAndJoin(nameInput.value);
    });
    create.className = 'primary';

    const codeInput = el('input', 'code');
    codeInput.maxLength = 4;
    codeInput.placeholder = 'CODE';
    codeInput.autocomplete = 'off';
    codeInput.spellcheck = false;
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
    });
    const join = button('JOIN', () => {
      saveName(nameInput.value.trim());
      void this.app.joinRoom(nameInput.value, codeInput.value);
    });
    const joinRow = el('div', 'row');
    joinRow.append(codeInput, join);

    for (const input of [nameInput, codeInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        (input === nameInput && codeInput.value === '' ? create : join).click();
      });
    }

    const notice = el('p', 'notice', this.app.notice);
    this.noticeEl = notice;

    box.append(nameLabel, create, el('p', 'or', 'OR JOIN A FRIEND'), joinRow, notice);
    box.append(el('p', 'help', 'WASD OR ARROWS TO MOVE  -  1 2 3 4 FOR ABILITIES'));
    this.setBusy(this.app.busy, box);
    queueMicrotask(() => nameInput.focus());
    return box;
  }

  private setBusy(busy: boolean, within: ParentNode = this.root): void {
    for (const b of within.querySelectorAll('button')) b.disabled = busy;
  }

  // ---- lobby ------------------------------------------------------------------

  private lobbyScreen(): HTMLElement {
    const { session } = this.app;
    const room = session.room!;
    const box = el('div', 'panel');
    box.append(el('p', 'sub', 'ROOM CODE - SHARE IT WITH FRIENDS'));
    box.append(el('h1', 'roomcode', session.code ?? '----'));

    const list = el('ul', 'players');
    for (const m of room.players) list.append(this.playerRow(m, room.hostId, session.playerId));
    box.append(list);
    box.append(el('p', 'sub', `${room.players.length} OF ${room.maxPlayers} PLAYERS`));
    if (room.waiting.length > 0) box.append(el('p', 'help', `WAITING FOR A SEAT: ${room.waiting.join(', ')}`));
    if (session.spectating) box.append(el('p', 'notice', 'ROOM WAS FULL - YOU WILL JOIN WHEN A SEAT OPENS'));

    const connected = room.players.filter((m) => m.connected).length;
    const counting = room.phase === 'countdown';
    const status = el('p', 'countdown');
    this.countdownEl = status;
    box.append(status);

    if (session.isHost) {
      const enough = connected >= room.minPlayers;
      box.append(button(counting ? 'STARTING...' : 'START MATCH', () => this.app.start(), !enough || counting, 'primary'));
      if (!enough) box.append(el('p', 'help', `NEED AT LEAST ${room.minPlayers} PLAYERS TO START`));
    } else {
      box.append(el('p', 'help', counting ? '' : 'WAITING FOR THE HOST TO START'));
    }

    if (session.lastError) box.append(el('p', 'notice', session.lastError.message.toUpperCase()));
    box.append(button('LEAVE', () => this.app.leave()));
    return box;
  }

  private playerRow(m: RoomMember, hostId: string | null, me: string | null): HTMLElement {
    const row = el('li', m.connected ? '' : 'away');
    const swatch = el('span', 'swatch');
    swatch.style.background = HERO_PALETTE[m.colorIndex % HERO_PALETTE.length];
    const name = el('span', 'name', m.name.toUpperCase());
    name.style.color = HERO_PALETTE[m.colorIndex % HERO_PALETTE.length];
    row.append(swatch, name);
    if (m.id === hostId) row.append(el('span', 'tag', 'HOST'));
    if (m.id === me) row.append(el('span', 'tag you', 'YOU'));
    if (!m.connected) row.append(el('span', 'tag', 'AWAY'));
    return row;
  }

  private tickCountdown(): void {
    if (!this.countdownEl) return;
    const left = this.app.session.countdownLeftMs(performance.now());
    this.countdownEl.textContent = left === null ? '' : `STARTING IN ${Math.max(1, Math.ceil(left / 1000))}`;
  }

  // ---- results ----------------------------------------------------------------

  private resultsScreen(): HTMLElement {
    const { session } = this.app;
    const box = el('div', 'panel');
    box.append(el('h1', '', 'MATCH OVER'));

    const table = el('ol', 'ranking');
    const ranking = session.results;
    if (!ranking) {
      box.append(el('p', 'sub', 'COUNTING THE ORBS...'));
    } else {
      for (const entry of ranking) {
        const colour = HERO_PALETTE[(session.matchPlayers.find((m) => m.id === entry.playerId)?.colorIndex ?? 0) % HERO_PALETTE.length];
        const row = el('li', entry.playerId === session.playerId ? 'me' : '');
        row.style.color = colour;
        row.append(el('span', 'rank', String(entry.rank)), el('span', 'name', entry.name.toUpperCase()));
        row.append(el('span', 'orbs', `${entry.orbs} ORBS`));
        table.append(row);
      }
      box.append(table);
    }

    if (session.isHost) box.append(button('PLAY AGAIN', () => this.app.playAgain(), false, 'primary'));
    else box.append(el('p', 'help', 'WAITING FOR THE HOST (BACK TO THE LOBBY AUTOMATICALLY SOON)'));
    box.append(button('LEAVE', () => this.app.leave()));
    return box;
  }
}
