import { memo, useMemo } from "react";
import type { Role } from "./types.ts";
import { CHARACTERS, type HairStyle } from "./characters.ts";

/**
 * Tiny pixel-art toolkit: sprites are string grids ("." = transparent, one char = one palette colour) rendered as
 * horizontally merged <rect>s inside a crispEdges SVG. Characters are generated procedurally so every role shares one
 * consistent chibi body (big head, small body, red Hasaki shirt) with its own hair, accessories and skin tone.
 */

export type Palette = Record<string, string>;
export type Grid = string[];

export const Px = memo(function Px({ rows, pal, x = 0, y = 0, className }: { rows: Grid; pal: Palette; x?: number; y?: number; className?: string }) {
  const rects = useMemo(() => {
    const out: Array<{ x: number; y: number; w: number; c: string }> = [];
    rows.forEach((row, ry) => {
      let i = 0;
      while (i < row.length) {
        const ch = row[i];
        if (ch === "." || ch === " ") {
          i++;
          continue;
        }
        let j = i + 1;
        while (j < row.length && row[j] === ch) j++;
        out.push({ x: i, y: ry, w: j - i, c: ch });
        i = j;
      }
    });
    return out;
  }, [rows]);
  const body = <g className={className}>{rects.map((r, k) => <rect key={k} x={r.x} y={r.y} width={r.w} height={1} fill={pal[r.c] ?? "#f0f"} />)}</g>;
  // never put a CSS-animated class and an SVG translate on the same element (CSS transform would win)
  return x || y ? <g transform={`translate(${x} ${y})`}>{body}</g> : body;
});

// ------------------------------------------------------------------ procedural chibi
export const SPRITE_W = 30;
export const SPRITE_H = 40;
const HX = 4, HY = 4, HW = 22, HH = 19; // head box inside the sprite canvas

type Canvas = string[][];
const blank = (): Canvas => Array.from({ length: SPRITE_H }, () => Array(SPRITE_W).fill("."));
const put = (c: Canvas, x: number, y: number, ch: string) => {
  if (y >= 0 && y < SPRITE_H && x >= 0 && x < SPRITE_W) c[y][x] = ch;
};
const rows = (c: Canvas): Grid => c.map((r) => r.join(""));
/** Dark outline on every filled pixel that touches transparency (classic pixel-art contour). */
function outline(c: Canvas, keep = "") {
  const filled = (x: number, y: number) => y >= 0 && y < SPRITE_H && x >= 0 && x < SPRITE_W && c[y][x] !== ".";
  const out = c.map((r) => [...r]);
  for (let y = 0; y < SPRITE_H; y++)
    for (let x = 0; x < SPRITE_W; x++)
      if (filled(x, y) && !keep.includes(c[y][x]) && (!filled(x - 1, y) || !filled(x + 1, y) || !filled(x, y - 1) || !filled(x, y + 1))) out[y][x] = "k";
  return out;
}

function inHead(hx: number, hy: number) {
  const cx = (HW - 1) / 2, cy = (HH - 1) / 2 + 0.3;
  return Math.pow(Math.abs(hx - cx) / (HW / 2), 3.2) + Math.pow(Math.abs(hy - cy) / (HH / 2), 3.2) <= 1;
}

type HairFn = (hx: number, hy: number, inside: boolean) => string | null;
const HAIR: Record<HairStyle, HairFn> = {
  // neat bob with a side part
  bob: (x, y, inside) => {
    if (inside && (y < 5 || (y < 7 && x < 13) || ((x <= 2 || x >= 19) && y < 13))) return y === 2 && x >= 5 && x <= 8 ? "H" : "h";
    if ((x === -1 || x === HW) && y >= 6 && y <= 13) return "h";
    return null;
  },
  // spiky, with a pencil behind the ear
  spiky: (x, y, inside) => {
    if (y === 7 && x >= HW - 1 && x <= HW + 2) return x === HW + 2 ? "Y" : "y";
    if (inside && (y < 5 || ((x <= 1 || x >= 20) && y < 9) || (y < 7 && x % 4 === 1))) return y === 2 && x >= 13 && x <= 15 ? "H" : "h";
    if (y === -1 && [3, 4, 8, 9, 13, 14, 17, 18].includes(x)) return "h";
    if (y === -2 && [4, 9, 14].includes(x)) return "h";
    return null;
  },
  // short hair + headphones
  short: (x, y, inside) => {
    if ((x >= -2 && x <= 0) || (x >= HW - 1 && x <= HW + 1)) if (y >= 9 && y <= 13) return "A";
    if (y === -1 && x >= 3 && x <= 18) return "a";
    if (y === 0 && (x === 2 || x === 19)) return "a";
    if ((x === -1 || x === HW) && y >= 1 && y <= 8) return "a";
    if (inside && (y < 4 || (y < 6 && x >= 4 && x <= 11) || ((x <= 1 || x >= 20) && y < 8))) return y === 1 && x >= 6 && x <= 9 ? "H" : "h";
    return null;
  },
  // side-swept fringe + ponytail
  ponytail: (x, y, inside) => {
    if (x === HW && (y === 4 || y === 5)) return "r";
    if (x >= HW && x <= HW + 2 && y >= 4 && y <= 13 - (x - HW) * 2) return "h";
    if (inside && (y < 4 || (x < 12 && y < 8 - Math.floor(x / 3)) || ((x <= 1 || x >= 20) && y < 10))) return y === 2 && x >= 4 && x <= 7 ? "H" : "h";
    return null;
  },
  // top bun
  bun: (x, y, inside) => {
    if ((x - 10.5) ** 2 + (y + 2) ** 2 <= 9) return y === -3 && (x === 9 || x === 10) ? "H" : "h";
    if (inside && (y < 5 || ((x <= 2 || x >= 19) && y < 10))) return y === 2 && x >= 14 && x <= 16 ? "H" : "h";
    return null;
  },
  // red Hasaki cap with a white mark
  cap: (x, y, inside) => {
    if (y === -1 && (x === 10 || x === 11)) return "r";
    if (y === 5 && x >= 3 && x <= HW + 3) return "R";
    if (inside && y < 5) return y === 2 && (x === 10 || x === 11) ? "w" : y === 4 ? "R" : "r";
    if (inside && (x <= 2 || x >= 19) && y >= 5 && y < 9) return "h";
    return null;
  },
};


export interface ChibiSprite {
  head: Grid;
  eyes: Grid;
  happyEyes: Grid;
  body: Grid;
  armL: Grid;
  armR: Grid;
  legL: Grid;
  legR: Grid;
  mouth: Record<"smile" | "open" | "frown" | "o" | "flat", Grid>;
}

function buildHead(role: Role): Grid {
  const c = blank();
  const look = CHARACTERS[role].look;
  const hair = HAIR[look.hairStyle];
  for (let hy = -4; hy < HH + 2; hy++)
    for (let hx = -4; hx < HW + 4; hx++) {
      const inside = inHead(hx, hy);
      const h = hair(hx, hy, inside);
      if (h) put(c, HX + hx, HY + hy, h);
      else if (inside) put(c, HX + hx, HY + hy, (hx > 15 && hy > 11) || hy >= HH - 2 ? "S" : "s");
    }
  // blush
  for (const [x, y] of [[4, 13], [5, 13], [16, 13], [17, 13]]) put(c, HX + x, HY + y, "c");
  const o = outline(c, "gyY");
  const g = look.glasses;
  if (g)
    for (const ox of [5, 13])
      for (let y = 9; y <= 13; y++)
        for (let x = ox; x <= ox + 3; x++) {
          const border = y === 9 || y === 13 || x === ox || x === ox + 3;
          const corner = g === "round" && (y === 9 || y === 13) && (x === ox || x === ox + 3);
          if (border && !corner) o[HY + y][HX + x] = "g";
        }
  if (g) for (let x = 9; x <= 12; x++) o[HY + 10][HX + x] = "g";
  return rows(o);
}

function pts(list: Array<[number, number, string]>): Grid {
  const c = blank();
  for (const [x, y, ch] of list) put(c, HX + x, HY + y, ch);
  return rows(c);
}

function buildBody(): Grid {
  const c = blank();
  const BX = 7, BY = HY + HH - 1; // shirt starts under the chin
  const span = (row: number) => (row === 0 ? [3, 12] : row === 1 ? [1, 14] : [0, 15]);
  for (let r = 0; r < 10; r++) {
    const [a, b] = span(r);
    for (let x = a; x <= b; x++) put(c, BX + x, BY + r, r === 9 || (x >= 12 && r >= 2) ? "R" : "r");
  }
  // polo: neck, folded white-trimmed collar, button placket
  for (const [x, y] of [[7, 0], [8, 0]]) put(c, BX + x, BY + y, "s");
  for (const [x, y] of [[4, 1], [5, 1], [6, 1], [9, 1], [10, 1], [11, 1], [5, 2], [6, 2], [9, 2], [10, 2]]) put(c, BX + x, BY + y, "C");
  for (const y of [1, 2, 3, 4]) put(c, BX + 7, BY + y, "R"), put(c, BX + 8, BY + y, y % 2 ? "B" : "R");
  const o = outline(c);
  // Hasaki-style chest emblem (stylised pixel "H"; the real logo is used on signage — see web/src/brand)
  const logo = ["whwhw", "whhhw", "whwhw"];
  logo.forEach((row, ry) => [...row].forEach((ch, rx) => (o[BY + 4 + ry][BX + 10 + rx] = ch === "h" ? "L" : "w")));
  return rows(o);
}

function buildArm(side: "L" | "R"): Grid {
  const c = blank();
  const x0 = side === "L" ? 3 : 23;
  const top = HY + HH;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 4; x++) put(c, x0 + x, top + y, y < 4 ? (x === (side === "L" ? 0 : 3) ? "R" : "r") : y === 4 ? "C" : "s");
  return rows(outline(c));
}

function buildLeg(side: "L" | "R"): Grid {
  const c = blank();
  const x0 = side === "L" ? 9 : 16;
  const top = HY + HH + 9;
  for (let y = 0; y < 6; y++) for (let x = 0; x < 5; x++) put(c, x0 + x, top + y, "p");
  for (let x = -1; x < 5; x++) put(c, x0 + x + (side === "R" ? 1 : 0), top + 6, "K");
  return rows(outline(c, "K"));
}

const cache = new Map<Role, ChibiSprite>();
export function chibiSprite(role: Role): ChibiSprite {
  let s = cache.get(role);
  if (!s) {
    s = {
      head: buildHead(role),
      eyes: pts([[6, 10, "w"], [7, 10, "e"], [6, 11, "e"], [7, 11, "e"], [6, 12, "e"], [7, 12, "e"], [14, 10, "w"], [15, 10, "e"], [14, 11, "e"], [15, 11, "e"], [14, 12, "e"], [15, 12, "e"]]),
      happyEyes: pts([[5, 12, "e"], [6, 11, "e"], [7, 11, "e"], [8, 12, "e"], [13, 12, "e"], [14, 11, "e"], [15, 11, "e"], [16, 12, "e"]]),
      body: buildBody(),
      armL: buildArm("L"),
      armR: buildArm("R"),
      legL: buildLeg("L"),
      legR: buildLeg("R"),
      mouth: {
        smile: pts([[9, 14, "m"], [12, 14, "m"], [10, 15, "m"], [11, 15, "m"]]),
        open: pts([[10, 14, "m"], [11, 14, "m"], [10, 15, "M"], [11, 15, "M"], [9, 14, "m"], [12, 14, "m"]]),
        frown: pts([[10, 14, "m"], [11, 14, "m"], [9, 15, "m"], [12, 15, "m"]]),
        o: pts([[10, 14, "m"], [11, 14, "m"], [10, 15, "m"], [11, 15, "m"]]),
        flat: pts([[10, 15, "m"], [11, 15, "m"]]),
      },
    };
    cache.set(role, s);
  }
  return s;
}

/** Hasaki red uniform. */
export const HASAKI_RED = "#e2231a";
export function chibiPalette(role: Role): Palette {
  const look = CHARACTERS[role].look;
  return {
    k: "#2b1d1a", e: "#2b1d1a", w: "#ffffff", c: "#f49a98", m: "#8a2a2a", M: "#d24b55",
    s: look.skin[0], S: look.skin[1], h: look.hair[0], H: look.hair[1], C: "#fff4f2", B: "#f7d4d1",
    r: HASAKI_RED, R: "#b3141a", L: HASAKI_RED, g: "#3a3a48", a: "#6b7488", A: "#3b4252",
    y: "#f5c542", Y: "#3a2a1a", p: look.pants, K: "#1d1d26",
  };
}

// ------------------------------------------------------------------ small props
export const PROPS = {
  paper: { rows: ["kkkkkkk", "kwwwwwk", "kwkkkwk", "kwwwwwk", "kwkkwwk", "kwwwwwk", "kwkkkwk", "kwwwwwk", "kkkkkkk"], pal: { k: "#5b5f6e", w: "#fbfbf7" } },
  mug: { rows: [".w.w.", "kkkkk.", "kwwwkk", "kwrwk.k", "kwwwkk", "kkkkk."], pal: { k: "#4b3a33", w: "#fff7ef", r: HASAKI_RED } },
  bulb: { rows: ["..kkk..", ".kyyyk.", "kyywyyk", "kyyyyyk", ".kyyyk.", "..kak..", "..kak..", "...k..."], pal: { k: "#6a5418", y: "#ffd84a", w: "#fffbe0", a: "#a3a3b0" } },
  question: { rows: [".kkkk.", "kwwwwk", "kwkkwk", "...kwk", "..kwk.", "..kwk.", "..kk..", "......", "..kk..", "..kk.."], pal: { k: "#7a3d00", w: "#ffd36b" } },
  check: { rows: ["......kk", ".....kgk", "k...kgk.", "kgk.kgk.", ".kgkgk..", "..kgk...", "...k...."], pal: { k: "#14532d", g: "#4ade80" } },
  sweat: { rows: [".k.", "kbk", "kbk", ".k."], pal: { k: "#2563eb", b: "#93c5fd" } },
  clip: { rows: [".kkk.", "kkkkkk", "kwwwwk", "kwgwwk", "kwwgwk", "kgwwwk", "kwwwwk", "kkkkkk"], pal: { k: "#6b4f2a", w: "#fffdf5", g: "#16a34a" } },
  glass: { rows: [".kkk..", "kbbbk.", "kbwbk.", "kbbbk.", ".kkkk.", "....kk", ".....k"], pal: { k: "#3a3a48", b: "#bfe3ff", w: "#ffffff" } },
  box: { rows: ["kkkkkkkkk", "kttttttdk", "kbbbbbbbk", "kbbwwwbbk", "kbbbbbbbk", "kbbbbbbbk", "kkkkkkkkk"], pal: { k: "#6b4423", t: "#c99a5b", d: "#b0844a", b: "#d9ad6d", w: HASAKI_RED } },
  book: { rows: ["kkkkkkkkk", "kwwwkwwwk", "kwkwkwkwk", "kwwwkwwwk", "kwkwkwkwk", "kkkkkkkkk"], pal: { k: "#7c2d12", w: "#fff7ed" } },
  plane: { rows: ["kk.....", "kwkk...", "kwwwkk.", "kwwwwwk", "kwwkk..", "kkk...."], pal: { k: "#475569", w: "#ffffff" } },
  zzz: { rows: ["kkk..", "..k..", ".k...", "kkk.."], pal: { k: "#64748b" } },
  branch: { rows: [".k...", "kgk.k", ".k.kgk", ".kk.k.", ".k....", "kgk...", ".k...."], pal: { k: "#14532d", g: "#22c55e" } },
} satisfies Record<string, { rows: Grid; pal: Palette }>;

export function Prop({ name, x, y, className }: { name: keyof typeof PROPS; x: number; y: number; className?: string }) {
  const p = PROPS[name];
  // position and animation on separate groups: a CSS transform would replace the SVG translate attribute
  return (
    <g transform={`translate(${x} ${y})`}>
      <Px rows={p.rows} pal={p.pal} className={className} />
    </g>
  );
}
