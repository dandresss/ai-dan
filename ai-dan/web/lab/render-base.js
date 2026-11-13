// What every part of the drawing shares: the palette, the fonts, text
// wrapping and a few Python formatting rules (render.py prints numbers with
// f-strings, and the page must print them the same way).
//
// Nothing here touches the DOM, so tests import it in Node.

// --- palette (render.py) -------------------------------------------------
export const ROOM_CENTER = [13, 13, 17];
export const ROOM_EDGE = [3, 3, 5];
export const PLATE = [11, 11, 14];
export const PLATE_EDGE = [22, 22, 27];
export const DORMANT = [25, 25, 30];          // a pin face at height 0, before the tint
export const TEXT = [206, 206, 214];
export const TEXT_DIM = [122, 122, 134];
export const TEXT_FAINT = [74, 74, 84];
export const PERSON = [255, 236, 214];
export const GHOST = [150, 175, 215];
export const WARN = [236, 170, 84];
export const AWAKE = [138, 214, 160];
export const ASLEEP = [110, 130, 180];
export const GONE = [100, 100, 108];
export const PANEL_BG = [9, 9, 12];
export const VOICE = [240, 200, 160];
export const THOUGHT = [186, 192, 214];
export const BLACK = [0, 0, 0];
export const WHITE = [255, 255, 255];

// --- fonts ---------------------------------------------------------------
// The desktop's _FAMILIES as CSS stacks. No web fonts: the page loads nothing
// from outside.
export const FAMILIES = {
  sans: '"Segoe UI", "Helvetica Neue", Helvetica, "DejaVu Sans", "Liberation Sans", Arial, sans-serif',
  serif: 'Georgia, Cambria, Palatino, "Palatino Linotype", "DejaVu Serif", "Liberation Serif", "Times New Roman", serif',
  mono: 'Consolas, Menlo, "SF Mono", "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace',
};
// Line height per em of the first font in each stack (ascent + descent), as
// pygame's Font.get_height() reports it.
const LINE = { sans: 1.33, serif: 1.14, mono: 1.17 };

/** A font: size in CSS px (at least 11, like render.font), CSS string, line height. */
export function font(role, size, italic = false) {
  const px = Math.max(11, Math.trunc(size));
  return {
    role,
    size: px,
    italic,
    css: `${italic ? "italic " : ""}${px}px ${FAMILIES[role]}`,
    lineH: Math.round(px * LINE[role]),
  };
}

// --- colour --------------------------------------------------------------
/** render._mix: integer channels, truncated like Python's int(). */
export function mix(a, b, k) {
  return [0, 1, 2].map((i) => Math.trunc(a[i] + (b[i] - a[i]) * k));
}

export function css(rgb, alpha = 1) {
  return alpha >= 1 ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

// --- Python formatting ---------------------------------------------------
/** render.clock: whole seconds as m:ss. */
export function clock(t) {
  const s = Math.max(0, Math.trunc(Number(t) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Python's f"{x:g}": six significant digits, no trailing zeros. */
export function formatG(x) {
  x = Number(x);
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [mant, expText] = x.toExponential(5).split("e");
  const exp = Number(expText);
  if (exp < -4 || exp >= 6) {
    const m = stripZeros(mant);
    return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return stripZeros(x.toFixed(Math.max(0, 5 - exp)));
}

function stripZeros(s) {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Python's f"{x:.nf}". JavaScript rounds exact binary ties away from zero;
 * Python rounds them to even. */
export function fixed(x, n) {
  x = Number(x);
  if (!Number.isFinite(x)) return formatG(x);
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  let s = a.toFixed(n);
  if (a < 1e21) {
    const exact = a.toFixed(100);             // the binary value, digit for digit
    const dot = exact.indexOf(".");
    const rest = exact.slice(dot + 1 + n);
    if (/^50*$/.test(rest)) {
      const down = exact.slice(0, dot + 1 + n).replace(/\.$/, "");
      if (Number(down.at(-1)) % 2 === 0) s = down;
    }
  }
  return neg ? `-${s}` : s;
}

/** Python's repr of a float (enough for display: 5 -> "5.0"). */
export function floatText(v) {
  return Number.isInteger(v) && Math.abs(v) < 1e16 ? `${v}.0` : String(v);
}

/** Python's truthiness for JSON values. */
export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === "object") return Object.keys(v).length > 0;
  if (typeof v === "number") return v !== 0;     // NaN is true in Python too
  return Boolean(v);
}

/** Python's float() of a JSON value; throws where Python raises. */
export function pyFloat(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim().replace(/_/g, "");
    if (/^[+-]?((\d+\.?\d*|\.\d+)(e[+-]?\d+)?|inf(inity)?|nan)$/i.test(s)) {
      const low = s.toLowerCase().replace(/^\+/, "");
      if (low.endsWith("inf") || low.endsWith("infinity")) return low.startsWith("-") ? -Infinity : Infinity;
      if (low.endsWith("nan")) return NaN;
      return Number(s);
    }
  }
  throw new TypeError("not a number");
}

/** Python's repr of a JSON value, the way an f-string prints a list. */
export function pyRepr(v, top = true) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return top ? v : quote(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyRepr(x, false)).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${quote(k)}: ${pyRepr(x, false)}`).join(", ")}}`;
}

function quote(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
}

/** Python's json.dumps with its default separators and ensure_ascii. */
export function pyJson(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? "NaN" : (v > 0 ? "Infinity" : "-Infinity"));
  if (typeof v === "string") {
    return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyJson(k)}: ${pyJson(x)}`).join(", ")}}`;
}

/** Thousands separated, as the README writes token counts: 21,637. */
export function grouped(n) {
  return String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// --- text wrapping -------------------------------------------------------
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const SPACES = /[\s\x1c-\x1f\x85]+/u;

/** Python's str.splitlines(), or [""] for an empty string. */
export function splitLines(s) {
  const parts = s.split(LINE_BREAKS);
  if (parts.length > 1 && parts.at(-1) === "") parts.pop();
  return parts.length ? parts : [""];
}

/**
 * render.wrap: lines that fit `width`, measured with `measure(font, text)`.
 * A paragraph that fits keeps its spacing as written; very long words break.
 */
export function wrap(measure, f, s, width) {
  const fits = (x) => measure(f, x) <= width;
  const lines = [];
  for (const para of splitLines(s)) {
    if (fits(para)) {
      lines.push(para);
      continue;
    }
    let line = "";
    for (let word of para.split(SPACES).filter(Boolean)) {
      while (!fits(word) && [...word].length > 1) {
        const chars = [...word];
        let cut = chars.length;
        while (cut > 1 && !fits(chars.slice(0, cut).join(""))) cut -= 1;
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(chars.slice(0, cut).join(""));
        word = chars.slice(cut).join("");
      }
      const trial = line ? `${line} ${word}` : word;
      if (fits(trial)) {
        line = trial;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A measure function backed by a canvas context, cached: the same strings
 * are measured 60 times a second. */
export function canvasMeasure(ctx) {
  const cache = new Map();
  return (f, s) => {
    const key = `${f.css}\n${s}`;
    let w = cache.get(key);
    if (w === undefined) {
      if (cache.size > 4000) cache.clear();
      ctx.font = f.css;
      w = ctx.measureText(s).width;
      cache.set(key, w);
    }
    return w;
  };
}

// --- canvas helpers ------------------------------------------------------
/** A rounded-rectangle path (pygame's border_radius, clamped the same way). */
export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Text with its top at y, like a pygame text surface blitted at y. */
export function drawText(ctx, f, text, color, x, y) {
  ctx.font = f.css;
  ctx.fillStyle = css(color);
  ctx.fillText(text, x, y + f.lineH / 2);
}

export function ring(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, r - 0.5), 0, Math.PI * 2);
  ctx.strokeStyle = css(color);
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function dot(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = css(color);
  ctx.fill();
}
