import Phaser from 'phaser';

/** Retro palette taken from the reference art: flat colours, no glow. */
export const PALETTE = {
  background: '#1d1f3a',
  hud: '#14152b',
  line: '#b9bfd6',
  text: '#ffffff',
  cyan: '#5ad7f0',
  pink: '#ff4fa3',
  yellow: '#f0d62a',
  indigo: '#3f4fb8',
  lightIndigo: '#8f9bff',
  grey: '#b9bfd6',
  dimGrey: '#5b5e80',
  red: '#e8453c', // reserved for danger
} as const;

/**
 * Sprites are tiny text bitmaps: '#' is a pixel, '.' is empty.
 * They are drawn in code, so the game needs no image files.
 */
export const BITMAPS = {
  hero: [
    '...#...',
    '..###..',
    '.#####.',
    '##.#.##',
    '#######',
    '.#...#.',
    '#.....#',
  ],
  crab: [
    '..#.....#..',
    '...#...#...',
    '..#######..',
    '.##.###.##.',
    '###########',
    '#.#######.#',
    '#.#.....#.#',
    '...##.##...',
  ],
  star: [
    '...###...',
    '.#######.',
    '##.###.##',
    '#########',
    '..#####..',
    '.#.....#.',
    '#.......#',
  ],
  bug: [
    '#.......#',
    '.#.###.#.',
    '..#####..',
    '.##.#.##.',
    '#########',
    '#.#####.#',
    '#.#...#.#',
    '..##.##..',
  ],
  orb: [
    '..#..',
    '.###.',
    '#####',
    '.###.',
    '..#..',
  ],
  heart: [
    '.##.##.',
    '#######',
    '#######',
    '.#####.',
    '..###..',
    '...#...',
  ],
} as const;

/** Draws a bitmap into a Phaser texture at the given pixel scale. Safe to call twice. */
export function makeSpriteTexture(
  scene: Phaser.Scene,
  key: string,
  rows: readonly string[],
  color: string,
  scale: number,
): void {
  if (scene.textures.exists(key)) return;
  const texture = scene.textures.createCanvas(key, rows[0].length * scale, rows.length * scale);
  if (!texture) throw new Error(`Could not create texture "${key}"`);
  const ctx = texture.getContext();
  ctx.fillStyle = color;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  });
  texture.refresh();
}

/** Creates every texture the game uses. Texture keys match the core names (e.g. drifter kind). */
export function registerTextures(scene: Phaser.Scene): void {
  makeSpriteTexture(scene, 'hero', BITMAPS.hero, PALETTE.cyan, 4);
  makeSpriteTexture(scene, 'crab', BITMAPS.crab, PALETTE.yellow, 4);
  makeSpriteTexture(scene, 'star', BITMAPS.star, PALETTE.pink, 3);
  makeSpriteTexture(scene, 'bug', BITMAPS.bug, PALETTE.grey, 4);
  makeSpriteTexture(scene, 'orb', BITMAPS.orb, PALETTE.yellow, 3);
  makeSpriteTexture(scene, 'heart', BITMAPS.heart, PALETTE.pink, 3);
  makeSpriteTexture(scene, 'heart-empty', BITMAPS.heart, PALETTE.dimGrey, 3);
}
