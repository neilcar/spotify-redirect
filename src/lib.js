// Pure lookup logic: no browser.* calls, so test/run.mjs can drive it from Node.
// Every network function takes a fetch implementation as its last argument.

const SR = (() => {
  const SPOTIFY_PATH = /^\/(?:intl-[a-z-]+\/)?(track|album|artist)\/([A-Za-z0-9]{22})(?:\/|$)/;

  function parseSpotifyUrl(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/^(open|play)\.spotify\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(SPOTIFY_PATH);
    return m ? { type: m[1], id: m[2] } : null;
  }

  // Drop featured-artist and remaster/edition noise, keeping case: used for search queries.
  // "To The Moon (Plan C) - feat. Steve Lacy" -> "To The Moon (Plan C)"
  function cleanTitle(s) {
    return (s || "")
      .replace(/\s*[([](?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]/gi, "")
      .replace(/\s+-\s+(?:feat|ft|featuring|with)\.?\s.*$/i, "")
      .replace(/\s+(?:feat|ft|featuring)\.?\s.*$/i, "")
      .replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|mono|stereo|single|radio edit|edit)\b.*$/i, "")
      .replace(/\s*[([](?:\d{4}\s+)?(?:remaster(?:ed)?|deluxe|expanded|bonus)[^)\]]*[)\]]/gi, "")
      .trim();
  }

  // Lowercase, strip accents, feat./remaster/version noise and punctuation.
  function normalize(s) {
    return cleanTitle((s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, ""))
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/^the\s+/, "")
      .trim();
  }

  function sameName(a, b) {
    const x = normalize(a), y = normalize(b);
    return !!x && !!y && x === y;
  }

  // "A, B & C" / "A and B" / "A x B" / "A feat. B" -> ["a", "b", "c"]
  function splitArtists(s) {
    return (s || "")
      .split(/\s*(?:,|&|\band\b|\bx\b|\bwith\b|\bfeat\.?|\bft\.?|\/)\s*/i)
      .map(normalize)
      .filter(Boolean);
  }

  function artistMatches(candidate, artists) {
    const c = normalize(candidate);
    if (!c) return false;
    const parts = splitArtists(candidate);
    return artists.some((a) => {
      const n = normalize(a);
      return n && (n === c || parts.includes(n) || splitArtists(a).includes(c));
    });
  }

  // ---------- Spotify metadata (from the public embed page) ----------

  async function spotifyMeta({ type, id }, fetchImpl) {
    const res = await fetchImpl(`https://open.spotify.com/embed/${type}/${id}`, {
      credentials: "omit",
    });
    if (!res.ok) throw new Error(`spotify embed ${res.status}`);
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("spotify embed: no __NEXT_DATA__");
    const e = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
    if (!e) throw new Error("spotify embed: no entity");
    const title = e.name || e.title;
    let artists = [];
    if (Array.isArray(e.artists)) artists = e.artists.map((a) => a.name).filter(Boolean);
    else if (type === "album" && e.subtitle) artists = e.subtitle.split(/,\s*/);
    if (type === "artist") artists = [title];
    return { type, title, artists };
  }

  // ---------- Bandcamp ----------

  const BC_FILTER = { track: "t", album: "a", artist: "b" };

  async function bandcampFind(meta, fetchImpl) {
    const q = meta.type === "artist" ? meta.title : `${meta.artists[0] || ""} ${cleanTitle(meta.title)}`;
    const res = await fetchImpl(
      "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic",
      {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search_text: q.trim(),
          search_filter: BC_FILTER[meta.type],
          full_page: false,
          fan_id: null,
        }),
      },
    );
    if (!res.ok) throw new Error(`bandcamp ${res.status}`);
    const results = (await res.json())?.auto?.results || [];
    const want = BC_FILTER[meta.type];
    const matches = results.filter((r) => {
      if (r.type !== want) return false;
      if (meta.type === "artist") return sameName(r.name, meta.title);
      return sameName(r.name, meta.title) && artistMatches(r.band_name, meta.artists);
    });
    // Several matches are common (regional editions, reissues, covers): take the first one that
    // is the artist's own release and plays in full.
    for (const hit of matches.slice(0, 5)) {
      if (meta.type !== "artist" && !(await bandcampAcceptable(hit, meta, fetchImpl))) continue;
      const url = hit.item_url_path || hit.item_url_root;
      if (url) return url.split("?")[0];
    }
    return null;
  }

  // A track counts as playable if Bandcamp streams it in full; an album only if every track
  // streams (pre-orders and "1 track preview" albums don't count). The account must also be the
  // artist's: covers are often uploaded with the original artist typed in as the artist name.
  async function bandcampAcceptable(hit, meta, fetchImpl) {
    const res = await fetchImpl(
      `https://bandcamp.com/api/mobile/25/tralbum_details?band_id=${hit.band_id}` +
        `&tralbum_id=${hit.id}&tralbum_type=${hit.type}`,
      { credentials: "omit" },
    );
    if (!res.ok) throw new Error(`bandcamp details ${res.status}`);
    const details = await res.json();
    const owners = [details?.band?.name, ...(details?.tracks || []).map((t) => t.band_name)];
    return isPlayable(details) && owners.some((o) => artistMatches(o, meta.artists));
  }

  function isPlayable(details) {
    const tracks = details?.tracks || [];
    return tracks.length > 0 && tracks.every((t) => t.is_streamable && t.streaming_url);
  }

  // ---------- Tidal (official API, client-credentials) ----------

  let tidalToken = null; // { key, value, expires }

  async function tidalAuth(cfg, fetchImpl) {
    const key = cfg.tidalClientId;
    if (tidalToken && tidalToken.key === key && tidalToken.expires > Date.now() + 60_000) {
      return tidalToken.value;
    }
    const res = await fetchImpl("https://auth.tidal.com/v1/oauth2/token", {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(`${cfg.tidalClientId}:${cfg.tidalClientSecret}`),
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`tidal auth ${res.status}`);
    const j = await res.json();
    tidalToken = { key, value: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
    return tidalToken.value;
  }

  // params go through URLSearchParams so "filter[query]" is sent as filter%5Bquery%5D: with
  // literal brackets Tidal treats the search text as un-decoded ("Erykah%20Badu...").
  async function tidalGet(path, params, cfg, fetchImpl) {
    const token = await tidalAuth(cfg, fetchImpl);
    const qs = new URLSearchParams({ ...params, countryCode: cfg.countryCode || "US" });
    const res = await fetchImpl(`https://openapi.tidal.com/v2${path}?${qs}`, {
      credentials: "omit",
      headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`tidal ${path} ${res.status}`);
    return res.json();
  }

  const TIDAL_KIND = { track: "tracks", album: "albums", artist: "artists" };

  function tidalTitle(attrs) {
    return attrs?.title || attrs?.name || "";
  }

  async function tidalFind(meta, cfg, fetchImpl) {
    if (!cfg.tidalClientId || !cfg.tidalClientSecret) return null;
    const kind = TIDAL_KIND[meta.type];
    const q = meta.type === "artist" ? meta.title : `${meta.artists[0] || ""} ${cleanTitle(meta.title)}`;
    const search = await tidalGet(
      "/searchResults",
      { "filter[query]": q.trim(), include: kind },
      cfg,
      fetchImpl,
    );
    const result = Array.isArray(search.data) ? search.data[0] : search.data;
    const included = (search.included || []).filter((r) => r.type === kind);
    const order = (result?.relationships?.[kind]?.data || []).map((r) => r.id);
    const byId = new Map(included.map((r) => [r.id, r]));
    const candidates = (order.length ? order.map((id) => byId.get(id)) : included).filter(Boolean);

    for (const c of candidates.slice(0, 8)) {
      if (!sameName(tidalTitle(c.attributes), meta.title)) continue;
      if (meta.type !== "artist") {
        // Search results don't carry artist names; fetch them for title matches only.
        const full = await tidalGet(`/${kind}/${c.id}`, { include: "artists" }, cfg, fetchImpl);
        const names = (full.included || [])
          .filter((r) => r.type === "artists")
          .map((r) => r.attributes?.name);
        if (!names.some((n) => artistMatches(n, meta.artists))) continue;
      }
      return `https://tidal.com/browse/${meta.type}/${c.id}`;
    }
    return null;
  }

  // https://tidal.com/browse/track/123 -> tidal://track/123 (opens the TIDAL desktop app)
  function tidalAppUrl(webUrl) {
    const m = (webUrl || "").match(/^https:\/\/tidal\.com\/browse\/(track|album|artist)\/(\d+)/);
    return m ? `tidal://${m[1]}/${m[2]}` : webUrl;
  }

  // ---------- Orchestration ----------

  async function resolve(spotifyUrl, cfg, fetchImpl) {
    const ref = parseSpotifyUrl(spotifyUrl);
    if (!ref) return { target: null, reason: "not a track/album/artist link" };
    const meta = await spotifyMeta(ref, fetchImpl);
    const finders = { bandcamp: bandcampFind, tidal: (m, f) => tidalFind(m, cfg, f) };
    const errors = [];
    for (const service of cfg.order || ["bandcamp", "tidal"]) {
      if (!finders[service]) continue;
      try {
        if (service === "tidal" && !(cfg.tidalClientId && cfg.tidalClientSecret)) {
          errors.push("tidal: skipped, no API keys set");
          continue;
        }
        const target = await finders[service](meta, fetchImpl);
        if (target) return { target, service, meta };
        errors.push(`${service}: not found`);
      } catch (e) {
        errors.push(`${service}: ${e.message}`);
      }
    }
    return { target: null, meta, reason: errors.join("; ") || "no services tried", notFound: errors.every((e) => e.endsWith("not found") || e.includes("skipped")) };
  }

  return { parseSpotifyUrl, tidalAppUrl, cleanTitle, normalize, sameName, artistMatches, isPlayable, spotifyMeta, bandcampFind, tidalFind, resolve };
})();

if (typeof module !== "undefined") module.exports = SR;
