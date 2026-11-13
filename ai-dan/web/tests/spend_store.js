// A stand-in for the Upstash Redis store that api/_spend.js counts in: the
// REST shape (POST a JSON command, get {"result": ...}), held in memory.

const URL_ = "https://spend-store.test";
let value = null;      // the counter, or null when unset
let failing = false;

export function storeOn(start = null) {
  process.env.KV_REST_API_URL = URL_;
  process.env.KV_REST_API_TOKEN = "store-token";
  value = start;
  failing = false;
}

export function storeOff() {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  value = null;
}

export const storeValue = () => Number(value ?? 0);
export const storeFails = (yes = true) => { failing = yes; };

/** Wrap a fetch so requests to the store are answered here and the rest go to `next`. */
export function withStore(next) {
  return async (url, init) => {
    if (!String(url).startsWith(URL_)) return next(url, init);
    if (failing) return new Response(JSON.stringify({ error: "store down" }), { status: 500 });
    if (init.headers.authorization !== "Bearer store-token") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    const [command, , amount] = JSON.parse(init.body);
    if (command === "GET") return Response.json({ result: value === null ? null : String(value) });
    if (command === "INCRBY") {
      value = Number(value ?? 0) + Number(amount);
      return Response.json({ result: value });
    }
    return new Response(JSON.stringify({ error: `unknown command ${command}` }), { status: 400 });
  };
}
