import { randomInt, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { HubError } from './hub.ts';

/**
 * A simple picture captcha, asked where the admin's security checks say (src/settings.ts). The hub draws 5 characters into a PNG
 * (pixels, not text a script can read out of the page), keeps the answer in memory for 10 minutes, and each picture is
 * checked once: right or wrong, it is used up and the portal asks for a new one. A restart forgets open pictures, so
 * someone mid-form just gets a new one. One hub process only: the answers are not shared between processes.
 */

// no look-alikes: 0/O/Q/D-ish, 1/I/L, S/5 kept as 5, Z/2 kept as 2, B/8 kept as 8, G/6 kept as 6
const ALPHABET = 'ACDEFHJKMNPRTUVWXY23456789';
export const CAPTCHA_LENGTH = 5;
const TTL_MS = 10 * 60_000;
const MAX_OPEN = 5000;
const W = 180, H = 60;

/** 5x7 glyphs, one string per row ('#' = ink). */
const FONT: Record<string, string> = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.', E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  P: '####.|#...#|#...#|####.|#....|#....|#....', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..', U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#', Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '#####|...#.|..#..|...#.|....#|#...#|.###.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
};
const GLYPHS = Object.fromEntries(Object.entries(FONT).map(([k, v]) => [k, v.split('|').map((row) => [...row].map((p) => p === '#'))]));

/** What the person typed, compared without case or spaces. */
export const normaliseAnswer = (v: unknown) => String(v ?? '').replace(/\s+/g, '').toUpperCase();

export class Captchas {
  private open = new Map<string, { answer: string; expires: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** A new picture. `answer` stays on the hub: the API sends only id and image. */
  issue(): { id: string; image: string; answer: string } {
    const now = this.now();
    if (this.open.size >= MAX_OPEN) {
      for (const [id, c] of this.open) if (c.expires <= now) this.open.delete(id);
      // still full (a flood of requests): drop the oldest
      for (const id of this.open.keys()) { if (this.open.size < MAX_OPEN) break; this.open.delete(id); }
    }
    let answer = '';
    for (let i = 0; i < CAPTCHA_LENGTH; i++) answer += ALPHABET[randomInt(ALPHABET.length)];
    const id = randomUUID();
    this.open.set(id, { answer, expires: now + TTL_MS });
    return { id, image: `data:image/png;base64,${drawPng(answer).toString('base64')}`, answer };
  }

  /** Throws CAPTCHA_WRONG unless `answer` matches picture `id`. The picture is used up either way. */
  check(id: unknown, answer: unknown): void {
    const key = typeof id === 'string' ? id : '';
    const c = this.open.get(key);
    this.open.delete(key);
    if (!key) throw wrong('Type the characters in the picture.');
    if (!c || c.expires <= this.now()) throw wrong('That picture has expired. Type the characters in the new one.');
    if (normaliseAnswer(answer) !== c.answer) throw wrong('The characters did not match. Try the new picture.');
  }
}

const wrong = (message: string) => new HubError('CAPTCHA_WRONG', message, 400, { fields: { captcha: message } });

// ---- drawing: each character rotated, scaled and moved a little, the whole line bent by a wave, then noise and lines

function drawPng(text: string): Buffer {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const bg = [rnd(225, 250), rnd(225, 250), rnd(225, 250)];
  const ink = new Uint8Array(W * H); // 1 = character pixel
  const cell = W / (text.length + 1);
  const chars = [...text].map((ch, i) => ({
    g: GLYPHS[ch]!, cx: cell * (i + 1) + rnd(-4, 4), cy: H / 2 + rnd(-5, 5), a: rnd(-0.35, 0.35), sx: rnd(4.2, 5.2), sy: rnd(5, 6),
  }));
  const wave = { amp: rnd(2, 4), freq: rnd(0.04, 0.07), phase: rnd(0, Math.PI * 2) };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wy = y + wave.amp * Math.sin(x * wave.freq + wave.phase);
      for (const c of chars) {
        const dx = x - c.cx, dy = wy - c.cy;
        if (Math.abs(dx) > 26 || Math.abs(dy) > 30) continue;
        const cos = Math.cos(-c.a), sin = Math.sin(-c.a);
        const u = Math.floor((dx * cos - dy * sin) / c.sx + 2.5), v = Math.floor((dx * sin + dy * cos) / c.sy + 3.5);
        if (u >= 0 && u < 5 && v >= 0 && v < 7 && c.g[v]![u]) { ink[y * W + x] = 1; break; }
      }
    }
  }
  // crossing lines in the ink colour, so they cannot be told apart from the characters by colour
  for (let n = 0; n < 4; n++) {
    let x0 = rnd(0, W * 0.3), y0 = rnd(0, H);
    const x1 = rnd(W * 0.7, W), y1 = rnd(0, H), steps = Math.ceil(x1 - x0), dy = (y1 - y0) / steps;
    for (let s = 0; s < steps; s++, x0++, y0 += dy) {
      const px = Math.round(x0), py = Math.round(y0);
      if (py >= 0 && py < H && px >= 0 && px < W) ink[py * W + px] = 1;
    }
  }
  const rgb = Buffer.alloc((W * 3 + 1) * H);
  const inkColour = [rnd(20, 70), rnd(20, 70), rnd(60, 110)];
  for (let y = 0; y < H; y++) {
    rgb[y * (W * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const on = ink[y * W + x] === 1, speck = Math.random() < 0.06;
      const base = on ? inkColour : speck ? [rnd(80, 180), rnd(80, 180), rnd(80, 180)] : bg;
      const o = y * (W * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) rgb[o + k] = Math.max(0, Math.min(255, base[k]! + rnd(-12, 12)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rgb)), chunk('IEND', Buffer.alloc(0))]);
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  let c = 0xffffffff;
  for (const b of Buffer.concat([head.subarray(4), data])) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
