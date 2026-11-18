/* global SR */
const DEFAULTS = {
  enabled: true,
  order: ["bandcamp", "tidal"],
  tidalClientId: "",
  tidalClientSecret: "",
  countryCode: "US",
  tidalOpenIn: "app", // "app" = TIDAL desktop app, "web" = tidal.com
  tidalAutoplay: false, // play in the TIDAL app through the native helper (native/install.sh)
  timeoutMs: 6000,
};
// Settings that change lookup results; changing one clears the cache.
const LOOKUP_KEYS = ["order", "tidalClientId", "tidalClientSecret", "countryCode"];
const NATIVE_HOST = "spotify_redirect_tidal";
const NATIVE_PERM = { permissions: ["nativeMessaging"] };
let canNative = false; // optional permission granted
// In MV3 the user can withhold host permissions (an install from a file may not even offer
// them). Without them nothing works: no Spotify interception, no lookups. Flag it loudly.
const SITE_ACCESS = { origins: browser.runtime.getManifest().host_permissions };
let hasSiteAccess = true;

// handoff.html is web-accessible (a webRequest redirect can only land on such a page), so any
// site could open it. Each redirect carries a one-time token naming what to play; the page
// only acts on a token this script issued in the last minute.
const handoffs = new Map(); // token -> { type, id, at }
function issueHandoff(type, id) {
  const token = crypto.randomUUID();
  handoffs.set(token, { type, id, at: Date.now() });
  for (const [t, h] of handoffs) if (Date.now() - h.at > 60_000) handoffs.delete(t);
  return token;
}
function redeemHandoff(token) {
  const h = handoffs.get(token);
  handoffs.delete(token);
  return h && Date.now() - h.at <= 60_000 ? h : null;
}
const HIT_TTL = 7 * 24 * 3600 * 1000;
const MISS_TTL = 24 * 3600 * 1000;
const BYPASS_PARAM = "nr"; // ?nr=1 on a Spotify link always opens Spotify

let cfg = { ...DEFAULTS };
const memo = new Map(); // spotify key -> { target, service, at }

async function loadConfig() {
  cfg = { ...DEFAULTS, ...(await browser.storage.local.get(Object.keys(DEFAULTS))) };
  canNative = await browser.permissions.contains(NATIVE_PERM);
  hasSiteAccess = await browser.permissions.contains(SITE_ACCESS);
  updateAction();
}

function updateAction() {
  if (!hasSiteAccess) {
    browser.action.setTitle({ title: "Spotify redirect needs site access: click to grant it" });
    browser.action.setBadgeText({ text: "!" });
    browser.action.setBadgeBackgroundColor({ color: "#d70022" });
    return;
  }
  browser.action.setTitle({ title: `Spotify redirect: ${cfg.enabled ? "on" : "off"}` });
  browser.action.setBadgeText({ text: cfg.enabled ? "" : "off" });
  browser.action.setBadgeBackgroundColor({ color: "#777" });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some((k) => LOOKUP_KEYS.includes(k))) {
    // Lookup settings changed (e.g. Tidal keys added): cached misses may now be hits.
    memo.clear();
    browser.storage.local.remove("cache");
  }
  if (Object.keys(changes).some((k) => k in DEFAULTS)) loadConfig();
});

browser.permissions.onAdded.addListener(loadConfig);
browser.permissions.onRemoved.addListener(loadConfig);

browser.action.onClicked.addListener(async () => {
  if (!hasSiteAccess) return browser.runtime.openOptionsPage(); // has the Grant button
  await browser.storage.local.set({ enabled: !cfg.enabled });
});

browser.runtime.onInstalled.addListener(async () => {
  if (!(await browser.permissions.contains(SITE_ACCESS))) browser.runtime.openOptionsPage();
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
        if (useApp && cfg.tidalAutoplay && canNative) {
          // The hand-off page asks the native helper to play it (see handoff.js).
          const m = SR.tidalAppUrl(r.target).match(/^tidal:\/\/(track|album|artist)\/(\d+)$/);
          if (m) return { redirectUrl: browser.runtime.getURL(`handoff.html#${issueHandoff(m[1], m[2])}`) };
        }
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

function nativeMessage(payload) {
  return browser.runtime.sendNativeMessage(NATIVE_HOST, payload)
    .catch((e) => ({ ok: false, opened: false, played: false, reason: `helper not available (${e.message})` }));
}

// From the options page ("Test" box, helper check) and the hand-off page.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.cmd === "autoplay") {
    const h = redeemHandoff(msg.token);
    if (!h) return Promise.resolve({ ok: false, opened: false, invalid: true, reason: "unknown or expired link" });
    return nativeMessage({ type: h.type, id: h.id }).then((r) => ({ ...r, type: h.type, id: h.id }));
  }
  if (msg?.cmd === "pingHelper") return nativeMessage({ ping: true });
  if (msg?.cmd === "closeTab" && sender.tab?.id >= 0) return browser.tabs.remove(sender.tab.id);
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
