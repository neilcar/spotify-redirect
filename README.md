# Spotify → Bandcamp / Tidal (Firefox)

When you open an `open.spotify.com` track, album or artist link, the extension looks the music
up and sends the tab to Bandcamp or Tidal instead. If neither has it, the link opens on Spotify.

How it works:
1. Reads the title and artists from Spotify's public embed page (no Spotify account needed).
2. Searches Bandcamp's public search API and keeps a result only if both title and artist match
   (accents, "feat.", "Remastered", "Deluxe" and so on are ignored), the release is on the
   artist's own Bandcamp account (not a cover uploaded under their name), and it plays in full:
   a track must stream, and an album only counts if every track streams (pre-orders and
   one-track previews are skipped). Artist links go to the artist's Bandcamp page.
3. Searches Tidal through the official API (needs a free app from developer.tidal.com).
   Tidal matches open in the TIDAL desktop app (`tidal://track/<id>`) by default, or on
   tidal.com if you pick "Web player" on the options page. The app opens the track's album with
   the track highlighted; nothing starts playing, because neither the app nor the web player
   has a link that plays something. A tab opened just for the link is closed once the app
   takes over (when Firefox loses focus, so the "Open TIDAL?" dialog stays up until you answer it). (That is what the "tabs" permission is for: it lets the extension see that
   the tab is empty.)
4. The order (Bandcamp first or Tidal first) is set on the options page. Results are cached:
   7 days for a match, 1 day for no match.

Escape hatches: add `?nr=1` to a link to open it on Spotify anyway. Click the toolbar button to
turn redirects off (the badge reads "off"). Lookups time out after 6 s, then open Spotify.

## Install
Download the signed `.xpi` from the latest GitHub Release and drag it onto a Firefox window (or
`about:addons` → gear → "Install Add-on From File…").

From 1.2.3 on it updates itself: the manifest's `update_url` points at `updates.json` on the
latest GitHub Release, and Firefox checks it about once a day (`about:addons` → gear → "Check
for Updates" to check now). Versions before 1.2.3 have no `update_url`, so install 1.2.3 by
hand once.

For a quick try without signing: `about:debugging#/runtime/this-firefox` → "Load Temporary
Add-on" → pick `src/manifest.json` (gone after a restart).

## Autoplay in TIDAL (optional)
Neither the TIDAL app nor tidal.com has a link that starts playback, so autoplay uses a small
helper on the Mac (`native/tidal-play.mjs`) that Firefox runs through native messaging. It
opens the link in TIDAL, then presses play in the app's own page through Chrome DevTools
Protocol on `127.0.0.1:47320`. That needs TIDAL started with `--remote-debugging-port=47320`.

    bash native/install.sh             # install or update (needs Node 22+)
    bash native/install.sh uninstall   # remove it

The installer adds the helper under `~/Library/Application Support/spotify-redirect/`, its
native messaging manifest for Firefox and Zen, and `~/Applications/TIDAL (autoplay).app`, a
launcher that starts TIDAL with the debug port. Use that launcher instead of TIDAL itself (put
it in the Dock). Then tick **Autoplay in TIDAL** on the options page; it asks for the native
messaging permission and checks the helper.

- TIDAL not running: the helper starts it with the port, then plays.
- TIDAL running without the port (started the normal way): the helper only opens the link;
  it never quits your TIDAL.
- Helper not installed: links open in TIDAL as before, without autoplay.

While TIDAL runs with the port, any program on this Mac can control it (and read its session)
through that port; it is bound to 127.0.0.1 only. Tracks play by double-clicking their row,
albums and artists through the page's Play button, so a TIDAL redesign can break autoplay;
links still open when it does.

## Develop
    npm ci
    npm test                              # offline unit checks
    npm run test:live                     # real lookups (network)
    npm run test:live -- <spotify-url>    # check particular links
    TIDAL_CLIENT_ID=… TIDAL_CLIENT_SECRET=… npm run test:live
    npm run lint
    npm run build                         # unsigned zip in dist/

CI (`.github/workflows/ci.yml`) runs the unit tests, lint and build on every push and pull
request, on the self-hosted `spr-amd64` runners (lxdk8s `fleet/arc-runner-spotify-redirect-amd64`).
Pull requests from forks run on GitHub-hosted runners instead, and need approval first.

## Release
1. Bump `version` in `src/manifest.json` (AMO refuses a version it has already signed) and merge.
2. Tag and push it:

       git tag v1.2.3 && git push origin v1.2.3

`.github/workflows/release.yml` checks the tag matches the manifest, signs the extension as an
unlisted add-on on addons.mozilla.org (waits for Mozilla's automated review) and attaches the
signed `.xpi` to a GitHub Release together with `updates.json` (written by
`scripts/updates-json.mjs`), which is what installed copies poll to update themselves. It needs the repo secrets `AMO_JWT_ISSUER` and
`AMO_JWT_SECRET` (API credentials from https://addons.mozilla.org/developers/addon/api/key/).
