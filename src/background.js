/* global SR */
const DEFAULTS = {
  enabled: true,
  order: ["bandcamp", "tidal"],
  tidalClientId: "",
  tidalClientSecret: "",
  countryCode: "US",
  tidalOpenIn: "app", // "app" = TIDAL desktop app, "web" = tidal.com
  timeoutMs: 6000,
};
const HIT_TTL = 7 * 24 * 3600 * 1000;
const MISS_TTL = 24 * 3600 * 1000;
const BYPASS_PARAM = "nr"; // ?nr=1 on a Spotify link always opens Spotify

let cfg = { ...DEFAULTS };
const memo = new Map(); // spotify key -> { target, service, at }

async function loadConfig() {
  cfg = { ...DEFAULTS, ...(await browser.storage.local.get(Object.keys(DEFAULTS))) };
  updateAction();
}

function updateAction() {
  browser.action.setTitle({ title: `Spotify redirect: ${cfg.enabled ? "on" : "off"}` });
  browser.action.setBadgeText({ text: cfg.enabled ? "" : "off" });
  browser.action.setBadgeBackgroundColor({ color: "#777" });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some((k) => k in DEFAULTS)) {
    // Settings changed (e.g. Tidal keys added): cached misses may now be hits.
    memo.clear();
    browser.storage.local.remove("cache");
    loadConfig();
  }
});

browser.action.onClicked.addListener(async () => {
  await browser.storage.local.set({ enabled: !cfg.enabled });
});

function cacheKey(ref) {
  return `${ref.type}:${ref.id}`;
}

async function cached(key) {
  const now = Date.now();
  let hit = memo.get(key);
  if (!hit) {
    const stored = (await browser.storage.local.get("cache")).cache || {};
    hit = stored[key];
  }
  if (!hit) return null;
  const ttl = hit.target ? HIT_TTL : MISS_TTL;
  return now - hit.at < ttl ? hit : null;
}

async function remember(key, value) {
  const entry = { ...value, at: Date.now() };
  memo.set(key, entry);
  const stored = (await browser.storage.local.get("cache")).cache || {};
  stored[key] = entry;
  // Keep the persistent cache small.
  const keys = Object.keys(stored);
  if (keys.length > 2000) {
    keys.sort((a, b) => stored[a].at - stored[b].at).slice(0, keys.length - 2000)
      .forEach((k) => delete stored[k]);
  }
  await browser.storage.local.set({ cache: stored });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

async function lookup(url) {
  const ref = SR.parseSpotifyUrl(url);
  if (!ref) return null;
  const key = cacheKey(ref);
  const hit = await cached(key);
  if (hit) return hit;
  const result = await SR.resolve(url, cfg, fetch.bind(globalThis));
  const entry = { target: result.target, service: result.service || null };
  // Don't cache errors (network/auth); do cache genuine "not found".
  if (result.target || result.notFound) await remember(key, entry);
  if (!result.target) console.info("spotify-redirect: staying on Spotify", url, result.reason);
  return entry;
}

// A tidal:// redirect hands off to the desktop app and the tab never loads anything. A tab
// opened just for the link is left empty showing the Spotify address, so close it. A tab
// that came from another page keeps that page. (Reading about:blank needs the tabs permission.)
//
// The close waits until Firefox loses focus, which is when the TIDAL app takes over. Until then
// Firefox may be showing its "Open TIDAL?" dialog in that tab, and closing the tab would
// throw the dialog away before it can be answered.
const PENDING_MS = 2 * 60 * 1000;
const pendingClose = new Map(); // tabId -> { spotifyUrl, at }

function closeIfLeftEmpty(tabId, spotifyUrl) {
  if (tabId >= 0) pendingClose.set(tabId, { spotifyUrl, at: Date.now() });
}

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== browser.windows.WINDOW_ID_NONE) return; // focus moved within Firefox
  const now = Date.now();
  for (const [tabId, { spotifyUrl, at }] of pendingClose) {
    pendingClose.delete(tabId);
    if (now - at > PENDING_MS) continue;
    browser.tabs.get(tabId).then((tab) => {
      const empty = tab.url === spotifyUrl || tab.url === "about:blank";
      if (empty) return browser.tabs.remove(tabId);
    }).catch(() => {}); // tab already gone
  }
});

browser.tabs.onRemoved.addListener((tabId) => pendingClose.delete(tabId));

browser.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (!cfg.enabled || details.method !== "GET") return {};
    const u = new URL(details.url);
    if (u.searchParams.has(BYPASS_PARAM)) return {};
    if (!SR.parseSpotifyUrl(details.url)) return {};
    try {
      const r = await withTimeout(lookup(details.url), cfg.timeoutMs);
      if (r?.target) {
        const useApp = r.service === "tidal" && cfg.tidalOpenIn === "app";
        if (useApp) closeIfLeftEmpty(details.tabId, details.url);
        return { redirectUrl: useApp ? SR.tidalAppUrl(r.target) : r.target };
      }
    } catch (e) {
      console.warn("spotify-redirect: lookup failed, opening Spotify", details.url, e);
    }
    return {};
  },
  { urls: ["*://open.spotify.com/*", "*://play.spotify.com/*"], types: ["main_frame"] },
  ["blocking"],
);

// Used by the options page's "Test" box.
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === "test") {
    return SR.resolve(msg.url, cfg, fetch.bind(globalThis))
      .then((r) => ({ ok: true, ...r }))
      .catch((e) => ({ ok: false, reason: e.message }));
  }
  if (msg?.cmd === "clearCache") {
    memo.clear();
    return browser.storage.local.remove("cache").then(() => ({ ok: true }));
  }
  return undefined;
});

loadConfig();
