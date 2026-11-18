// npm test — offline checks of URL parsing and name matching.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const SR = createRequire(import.meta.url)("../src/lib.js");
import { readFileSync } from "node:fs";
import { updatesJson, xpiName } from "../scripts/updates-json.mjs";

assert.deepEqual(SR.parseSpotifyUrl("https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=x"), { type: "track", id: "4cOdK2wGLETKBW3PvgPWqT" });
assert.deepEqual(SR.parseSpotifyUrl("https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa"), { type: "album", id: "4m2880jivSbbyEGAKfITCa" });
assert.equal(SR.parseSpotifyUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"), null);
assert.equal(SR.parseSpotifyUrl("https://example.com/track/4cOdK2wGLETKBW3PvgPWqT"), null);
assert.ok(SR.sameName("María También", "Maria Tambien"));
assert.ok(SR.sameName("Song (feat. Someone)", "song"));
assert.ok(SR.sameName("Paranoid Android - Remastered 2017", "Paranoid Android"));
assert.ok(SR.sameName("OK Computer (Deluxe Edition)", "OK Computer"));
assert.ok(!SR.sameName("Live Forever", "Forever"));
assert.ok(SR.artistMatches("Khruangbin & Leon Bridges", ["Leon Bridges"]));
const ok = { is_streamable: true, streaming_url: { "mp3-128": "x" } };
assert.ok(SR.isPlayable({ tracks: [ok, ok] }));
assert.ok(!SR.isPlayable({ tracks: [ok, { is_streamable: false, streaming_url: null }] }));
assert.ok(!SR.isPlayable({ tracks: [] }));
assert.ok(SR.artistMatches("Floating Points, Pharoah Sanders & The London Symphony Orchestra", ["Floating Points"]));
assert.ok(!SR.artistMatches("FilthyHare", ["Radiohead"]));
assert.equal(SR.cleanTitle("To The Moon (Plan C) - feat. Steve Lacy"), "To The Moon (Plan C)");
assert.ok(SR.sameName("To The Moon (Plan C) - feat. Steve Lacy", "To the Moon (Plan C)"));
assert.ok(SR.sameName("Song feat. Someone", "Song"));
assert.equal(SR.tidalAppUrl("https://tidal.com/browse/track/549743865"), "tidal://track/549743865");
// Self-hosted updates: update_url points at the latest release's updates.json, which links
// this version's signed .xpi under the same gecko id.
const manifest = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url)));
const gecko = manifest.browser_specific_settings.gecko;
assert.equal(gecko.update_url, "https://github.com/neilcar/spotify-redirect/releases/latest/download/updates.json");
const u = updatesJson(manifest).addons[gecko.id].updates[0];
assert.equal(u.version, manifest.version);
assert.equal(u.update_link, `https://github.com/neilcar/spotify-redirect/releases/download/v${manifest.version}/${xpiName(manifest.version)}`);
console.log("unit checks ok");
