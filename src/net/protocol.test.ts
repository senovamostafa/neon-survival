import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES, NAME_PATTERN, parseClientMessage, ROOM_CODE_PATTERN } from './protocol';

const parse = (m: unknown) => parseClientMessage(typeof m === 'string' ? m : JSON.stringify(m));

describe('parseClientMessage', () => {
  it('accepts every valid message', () => {
    expect(parse({ t: 'join', name: 'Alice_1' })).toEqual({ t: 'join', name: 'Alice_1' });
    expect(parse({ t: 'start' })).toEqual({ t: 'start' });
    expect(parse({ t: 'again' })).toEqual({ t: 'again' });
    expect(parse({ t: 'input', dx: 1, dy: -1 })).toEqual({ t: 'input', dx: 1, dy: -1 });
    expect(parse({ t: 'ability', id: 'teleport' })).toEqual({ t: 'ability', id: 'teleport' });
    expect(parse({ t: 'ping', ts: 123 })).toEqual({ t: 'ping', ts: 123 });
  });

  it('forces input to -1, 0 or 1 whatever is sent', () => {
    expect(parse({ t: 'input', dx: 999, dy: -0.2 })).toEqual({ t: 'input', dx: 1, dy: -1 });
    expect(parse({ t: 'input', dx: 0, dy: 0 })).toEqual({ t: 'input', dx: 0, dy: 0 });
  });

  it('rejects names that are not 3-12 letters, digits or underscores', () => {
    for (const name of ['ab', 'a'.repeat(13), 'has space', 'émile', 'semi;colon', '', '<b>x</b>']) {
      expect(parse({ t: 'join', name })).toBeNull();
    }
    expect(NAME_PATTERN.test('abc')).toBe(true);
    expect(NAME_PATTERN.test('abcdefghijkl')).toBe(true);
  });

  it('rejects anything that is not exactly a valid message', () => {
    const bad: unknown[] = [
      'not json',
      '',
      'null',
      '[]',
      '42',
      { t: 'nope' },
      { t: 'input', dx: 'a', dy: 0 },
      { t: 'input', dx: null, dy: 0 },
      { t: 'input', dx: 1 },
      { t: 'ability', id: 'fireball' },
      { t: 'ability' },
      { t: 'ping', ts: 'x' },
      { name: 'Alice' },
      { t: 'join' },
    ];
    for (const m of bad) expect(parse(m)).toBeNull();
    expect(parseClientMessage(undefined)).toBeNull();
    expect(parseClientMessage(12345)).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
  });

  it('rejects oversized messages', () => {
    const big = JSON.stringify({ t: 'join', name: 'Alice', pad: 'x'.repeat(MAX_MESSAGE_BYTES) });
    expect(parseClientMessage(big)).toBeNull();
  });

  it('knows what a room code looks like', () => {
    expect(ROOM_CODE_PATTERN.test('ABCD')).toBe(true);
    for (const code of ['abcd', 'ABC', 'ABCDE', 'AB1D', '']) expect(ROOM_CODE_PATTERN.test(code)).toBe(false);
  });
});
