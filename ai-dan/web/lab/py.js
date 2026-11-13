// Python-compatible numbers, JSON and SHA-256.
//
// The body's state hash and every string the model reads are produced in the
// Python lab by `round`, `repr` and `json.dumps`. JavaScript differs from them
// in small ways that change bytes; this module removes those differences.

// --- numbers -------------------------------------------------------------

// Python round(x): nearest integer, ties to even. Returns a Number holding the
// integer (never -0, like Python's int).
export function pyRound(x) {
  if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x} to an integer`);
  const floor = Math.floor(x);
  const diff = x - floor;                 // exact unless -0.5 < x < 0, where the answer is 0 anyway
  let r = floor;
  if (diff > 0.5 || (diff === 0.5 && floor % 2 !== 0)) r = floor + 1;
  return r === 0 ? 0 : r;
}

// Python round(x, n) for a float x: the exact binary value of x rounded to n
// decimals, ties to even, then read back as the nearest double. The sign is
// kept, so round(-0.001, 2) is -0.0.
export function pyRoundN(x, n) {
  if (!Number.isFinite(x)) return x;
  if (n > 323) return x;                  // CPython's NDIGITS_MAX
  if (n < -308) return 0 * x;             // CPython's NDIGITS_MIN: a signed zero
  if (n >= 0 && Number.isInteger(x)) return x;
  const { mantissa, exponent } = decompose(Math.abs(x));
  // |x| * 10^n = mantissa * 2^exponent * 10^n = num / den, all exact.
  let num = mantissa;
  let den = 1n;
  if (exponent >= 0) num <<= BigInt(exponent);
  else den <<= BigInt(-exponent);
  if (n >= 0) num *= 10n ** BigInt(n);
  else den *= 10n ** BigInt(-n);
  let q = num / den;
  const twice = 2n * (num - q * den);
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  const magnitude = Number(`${q}e${-n}`);
  return x < 0 || Object.is(x, -0) ? -magnitude : magnitude;
}

// A finite double as mantissa * 2^exponent, both exact (mantissa a BigInt).
function decompose(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (biased === 0) return { mantissa: fraction, exponent: -1074 };
  return { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

// Python repr(float(x)): the shortest digits that read back as x (the same
// digits JavaScript picks), laid out as Python lays them out.
export function floatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return `${sign}0.0`;
  const { digits, point } = shortestDigits(Math.abs(x));
  // `point`: x = 0.<digits> * 10^point. Python switches to an exponent
  // when point <= -4 or point > 16.
  if (point <= -4 || point > 16) {
    const exp = point - 1;
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const expDigits = String(Math.abs(exp)).padStart(2, "0");
    return `${sign}${mantissa}e${exp < 0 ? "-" : "+"}${expDigits}`;
  }
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function shortestDigits(x) {
  const [mant, exp = "0"] = String(x).split("e");
  const [whole, frac = ""] = mant.split(".");
  let digits = whole + frac;
  let point = whole.length + Number(exp);
  const lead = digits.length - digits.replace(/^0+/, "").length;
  digits = digits.slice(lead).replace(/0+$/, "");
  point -= lead;
  return { digits, point };
}

// Python max(a, b) and min(a, b): the first argument wins a tie, so
// max(-0.0, 0.0) is -0.0.
export function pyMax(a, b) {
  return b > a ? b : a;
}

export function pyMin(a, b) {
  return b < a ? b : a;
}

// --- strings -------------------------------------------------------------

// Python str.strip(): the characters str.isspace() accepts, which are not
// quite the ones String.prototype.trim() removes.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

export function pyStrip(text) {
  return text.replace(PY_STRIP, "");
}

// --- JSON ----------------------------------------------------------------

// Keys whose numbers are Python floats wherever they appear (see
// web/ARCHITECTURE.md): times, positions, heights, and Config's float fields.
export const FLOAT_KEYS = new Set([
  "t", "pos", "actual", "gap", "person",
  "FULL_TRAVEL_S", "MAX_TRACK_S", "PULSE_S", "ABSENCE_GRACE_S", "MAX_SESSION_MIN",
]);

// Python json.dumps(value, ensure_ascii=False). Python knows ints from
// floats; here a number is a float when it sits under a key in `floatKeys`,
// and otherwise an int when integral. -0 is always a float: a Python int
// cannot be negative zero.
export function pyDumps(value, { floatKeys = FLOAT_KEYS } = {}) {
  return dump(value, false, floatKeys);
}

function dump(value, isFloat, floatKeys) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      return dumpNumber(value, isFloat);
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return undefined;                 // undefined, functions: as JSON.stringify
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => dump(v, isFloat, floatKeys) ?? "null");
    return `[${items.join(", ")}]`;
  }
  const items = [];
  for (const [key, v] of Object.entries(value)) {
    const text = dump(v, isFloat || floatKeys.has(key), floatKeys);
    if (text !== undefined) items.push(`${JSON.stringify(key)}: ${text}`);
  }
  return `{${items.join(", ")}}`;
}

function dumpNumber(x, isFloat) {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (isFloat || !Number.isInteger(x) || Object.is(x, -0)) return floatRepr(x);
  return BigInt(x).toString();          // any size, never 1e+21
}

// Python json.loads. It also reads the Infinity and -Infinity that json.dumps
// writes for a number too large for a float (a model may write 1e400 in a
// tool input; both languages read it as infinity, and the log keeps it).
export function pyLoads(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const fixed = infinitiesAsNumbers(text);
    if (fixed === text) throw error;
    return JSON.parse(fixed);
  }
}

// Infinity outside strings becomes 1e999, which JSON reads as Infinity.
function infinitiesAsNumbers(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        out += text.slice(i, i + 2);
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (text.startsWith("Infinity", i)) {
      out += "1e999";
      i += "Infinity".length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// Python == between JSON values: 1 == 1.0, True == 1, dicts ignore key order.
export function pyEquals(a, b) {
  if (isNumeric(a) && isNumeric(b)) return Number(a) === Number(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => pyEquals(v, b[i]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && pyEquals(a[k], b[k]));
}

function isNumeric(x) {
  return typeof x === "number" || typeof x === "boolean";
}

// --- SHA-256 ---------------------------------------------------------------

const K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

// Hex SHA-256 of the UTF-8 bytes of `text`. Synchronous, unlike
// crypto.subtle, so the body can hash its state inside a tick.
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const blocks = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  blocks.set(bytes);
  blocks[bytes.length] = 0x80;
  const view = new DataView(blocks.buffer);
  const bits = bytes.length * 8;
  view.setUint32(blocks.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(blocks.length - 4, bits >>> 0);

  const H = Uint32Array.of(
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const W = new Uint32Array(64);
  for (let offset = 0; offset < blocks.length; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = W[i - 16] + s0 + W[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d;
    H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}
