// The tab lands here instead of on Spotify when "Autoplay in TIDAL" is on. The background
// script asks the native helper to open and play the link in the TIDAL app; this page then
// gets out of the way: back to the page the link was clicked on, or closed if the tab was
// opened just for the link. Without the helper it falls back to a plain tidal:// link.
// The URL carries only a one-time token (see background.js); what to play comes back with it.
const token = location.hash.slice(1);
const $ = (i) => document.getElementById(i);

function finish() {
  if (history.length > 1) history.back();
  else browser.runtime.sendMessage({ cmd: "closeTab" });
}

async function start() {
  const r = await browser.runtime.sendMessage({ cmd: "autoplay", token });
  if (r?.invalid) {
    $("status").textContent = "Nothing to open.";
    $("detail").textContent = "This page only works for links the extension just redirected.";
    return;
  }
  if (r?.opened) {
    if (!r.played) console.info("spotify-redirect: opened in TIDAL without autoplay:", r.reason);
    finish();
    return;
  }
  // No helper (or it failed before opening anything): open the link the plain way. Leave once
  // TIDAL takes focus, so Firefox's "Open TIDAL?" dialog can still be answered.
  console.info("spotify-redirect: autoplay helper unavailable:", r?.reason);
  $("detail").textContent = r?.reason ? `Autoplay unavailable: ${r.reason}` : "";
  window.addEventListener("blur", finish, { once: true });
  location.href = `tidal://${r.type}/${r.id}`;
}

start();
