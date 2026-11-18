// Native messaging helper for the extension: opens a Tidal track, album or artist in the TIDAL
// desktop app and starts playing it.
//
// TIDAL is an Electron app with no "play this" link, so the helper drives the app's own page
// through the Chrome DevTools Protocol on 127.0.0.1:PORT: it opens tidal://<type>/<id> (the
// app's own navigation), waits for the track's row or the page's Play button, and presses it.
// That needs TIDAL started with --remote-debugging-port=PORT. If TIDAL isn't running the helper
// starts it that way; if it is running without the port, the helper only opens the link.
//
// Firefox talks to it over stdin/stdout: each message is a 4-byte little-endian length plus
// UTF-8 JSON. Request {type: "track"|"album"|"artist", id: "123"}; reply
// {ok, opened, played, reason}. {ping: true} replies {ok, pong, debugPort, running}.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

export const PORT = 47320;
const CDP = `http://127.0.0.1:${PORT}`;
const TYPES = new Set(["track", "album", "artist"]);

// ---------- native messaging framing ----------

export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Pulls complete messages off the front of buf; returns { messages, rest }.
export function decodeMessages(buf) {
  const messages = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const len = buf.readUInt32LE(off);
    if (buf.length - off - 4 < len) break;
    messages.push(JSON.parse(buf.subarray(off + 4, off + 4 + len).toString("utf8")));
    off += 4 + len;
  }
  return { messages, rest: buf.subarray(off) };
}

// ---------- what to press in TIDAL's page ----------

// Expressions evaluated in TIDAL's page. They return a short status string.
export function pageScripts(type, id) {
  const sel = JSON.stringify(`[data-test="tracklist-row"][data-track-id="${id}"]`);
  const onPage = `location.pathname.split("/").includes(${JSON.stringify(id)})`;
  if (type === "track") {
    return {
      ready: `!!document.querySelector(${sel})`,
      press: `(() => { const r = document.querySelector(${sel}); if (!r) return "missing";
        r.scrollIntoView({ block: "center" });
        r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
        return "pressed"; })()`,
      playing: `document.querySelector(${sel})?.getAttribute("data-test-is-playing") === "true"`,
    };
  }
  return {
    ready: `${onPage} && !!document.querySelector('[data-test="play-all"]')`,
    press: `(() => { const b = document.querySelector('[data-test="play-all"]'); if (!b) return "missing";
      b.click(); return "pressed"; })()`,
    playing: `!!document.querySelector('[data-test="pause"]')`,
  };
}

// ---------- CDP ----------

async function pageTarget() {
  const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(1500) });
  const page = (await res.json()).find(
    (t) => t.type === "page" && t.url.startsWith("https://desktop.tidal.com"),
  );
  if (!page) throw new Error("no TIDAL page");
  return page;
}

async function connect() {
  const ws = new WebSocket((await pageTarget()).webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP connect failed")), { once: true });
  });
  let seq = 0;
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const onMessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        ws.removeEventListener("message", onMessage);
        if (m.error || m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.error || m.result.exceptionDetails)));
        else resolve(m.result.result.value);
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
  return { evaluate, close: () => ws.close() };
}

async function cdpUp() {
  try {
    await pageTarget();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await check()) return true;
    } catch {
      // page reloading or not ready yet
    }
    await sleep(every);
  }
  return false;
}

async function tidalRunning() {
  try {
    await run("/usr/bin/pgrep", ["-x", "TIDAL"]);
    return true;
  } catch {
    return false;
  }
}

// ---------- the request ----------

export async function handle({ type, id, ping }) {
  // The options page's check: is the helper installed, and is TIDAL reachable?
  if (ping) return { ok: true, pong: true, debugPort: await cdpUp(), running: await tidalRunning() };
  if (!TYPES.has(type) || !/^\d+$/.test(String(id))) return { ok: false, opened: false, reason: "bad request" };
  const link = `tidal://${type}/${id}`;

  if (!(await cdpUp())) {
    if (await tidalRunning()) {
      // Never quit the user's TIDAL: just open the page, as the extension would.
      await run("/usr/bin/open", [link]);
      return { ok: false, opened: true, played: false, reason: "TIDAL is running without the debug port; start it with the TIDAL (autoplay) launcher" };
    }
    await run("/usr/bin/open", ["-a", "TIDAL", "--args", `--remote-debugging-port=${PORT}`]);
    if (!(await waitFor(cdpUp, 30_000, 500))) {
      await run("/usr/bin/open", [link]);
      return { ok: false, opened: true, played: false, reason: "TIDAL started but its debug port never came up" };
    }
  }

  const page = await connect();
  try {
    // Wait for the player to load (a fresh start shows the page before the player bar).
    await waitFor(() => page.evaluate(`!!document.querySelector('[data-test="play"], [data-test="pause"]')`), 30_000);
    await run("/usr/bin/open", [link]);
    const s = pageScripts(type, id);
    if (!(await waitFor(() => page.evaluate(s.ready), 15_000))) {
      return { ok: false, opened: true, played: false, reason: `TIDAL opened the ${type} but its play control never appeared` };
    }
    if ((await page.evaluate(s.press)) !== "pressed") {
      return { ok: false, opened: true, played: false, reason: "play control disappeared" };
    }
    const played = await waitFor(() => page.evaluate(s.playing), 8_000);
    return { ok: played, opened: true, played, reason: played ? "playing" : "pressed play but TIDAL didn't start" };
  } finally {
    page.close();
  }
}

// ---------- stdio loop (when run by Firefox) ----------

async function main() {
  let buf = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = decodeMessages(buf);
    buf = rest;
    for (const msg of messages) {
      let reply;
      try {
        reply = await handle(msg);
      } catch (e) {
        reply = { ok: false, opened: false, played: false, reason: String(e?.message || e) };
      }
      process.stdout.write(encodeMessage(reply));
    }
  }
}

// Compare paths, not URLs: the installed helper lives under "Application Support" (a space).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
