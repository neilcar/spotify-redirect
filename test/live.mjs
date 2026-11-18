// npm run test:live -- [spotify-url ...] — real lookups against Spotify, Bandcamp and (when
// TIDAL_CLIENT_ID / TIDAL_CLIENT_SECRET are set) Tidal. Needs network; not run in CI.
import { createRequire } from "node:module";
const SR = createRequire(import.meta.url)("../src/lib.js");
const cfg = {
  order: ["bandcamp", "tidal"],
  tidalClientId: process.env.TIDAL_CLIENT_ID || "",
  tidalClientSecret: process.env.TIDAL_CLIENT_SECRET || "",
  countryCode: "US",
};
const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", // Rick Astley: not on Bandcamp
  "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa", // Daft Punk RAM: not on Bandcamp
  "https://open.spotify.com/artist/2mVVjNmdjXZZDvhgQWiakk", // Khruangbin
];
for (const u of urls) {
  try {
    const r = await SR.resolve(u, cfg, fetch);
    console.log(`${u}\n  ${r.meta ? `${r.meta.artists.join(", ")} — ${r.meta.title}` : ""}\n  -> ${r.target ? `${r.service} ${r.target}` : `spotify (${r.reason})`}`);
  } catch (e) { console.log(`${u}\n  ERROR ${e.message}`); }
}
