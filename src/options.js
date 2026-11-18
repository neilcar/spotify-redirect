const $ = (id) => document.getElementById(id);
// Settings are in storage.sync: Firefox/Zen Sync carries them to your other browsers.
const FIELDS = ["tidalClientId", "tidalClientSecret", "countryCode"];
const SELECTS = { tidalOpenIn: "app" };

async function load() {
  const s = await browser.storage.sync.get(["enabled", "order", ...FIELDS]);
  $("enabled").checked = s.enabled !== false;
  $("order").value = (s.order || ["bandcamp", "tidal"]).join(",");
  const sel = await browser.storage.sync.get(Object.keys(SELECTS));
  for (const [k, d] of Object.entries(SELECTS)) $(k).value = sel[k] || d;
  for (const f of FIELDS) $(f).value = s[f] || (f === "countryCode" ? "US" : "");
  const a = await browser.storage.sync.get("tidalAutoplay");
  $("tidalAutoplay").checked = !!a.tidalAutoplay && (await browser.permissions.contains(NATIVE_PERM));
  if ($("tidalAutoplay").checked) checkHelper();
}

const NATIVE_PERM = { permissions: ["nativeMessaging"] };

async function checkHelper() {
  $("helperStatus").textContent = "Checking the helper…";
  const r = await browser.runtime.sendMessage({ cmd: "pingHelper" });
  if (!r?.pong) {
    $("helperStatus").textContent = `Helper not found: ${r?.reason || "no reply"}. Links open in TIDAL without autoplay.`;
  } else if (r.debugPort) {
    $("helperStatus").textContent = "Helper ready; TIDAL is running with autoplay on.";
  } else if (r.running) {
    $("helperStatus").textContent = "Helper ready, but TIDAL was started without the launcher: quit it and use TIDAL (autoplay).";
  } else {
    $("helperStatus").textContent = "Helper ready; it will start TIDAL when you open a link.";
  }
}

$("tidalAutoplay").addEventListener("change", async () => {
  let on = $("tidalAutoplay").checked;
  // The permission prompt must come straight from the click, before any other await.
  if (on) on = await browser.permissions.request(NATIVE_PERM);
  $("tidalAutoplay").checked = on;
  await browser.storage.sync.set({ tidalAutoplay: on });
  if (on) checkHelper();
  else $("helperStatus").textContent = "";
});

function save() {
  return browser.storage.sync.set({
    enabled: $("enabled").checked,
    order: $("order").value.split(","),
    tidalClientId: $("tidalClientId").value.trim(),
    tidalClientSecret: $("tidalClientSecret").value.trim(),
    countryCode: ($("countryCode").value.trim() || "US").toUpperCase(),
    tidalOpenIn: $("tidalOpenIn").value,
  });
}

for (const id of ["enabled", "order", ...FIELDS, ...Object.keys(SELECTS)]) $(id).addEventListener("change", save);

$("test").addEventListener("click", async () => {
  $("out").textContent = "Looking up…";
  await save();
  const r = await browser.runtime.sendMessage({ cmd: "test", url: $("testUrl").value.trim() });
  const lines = [];
  if (r.meta) lines.push(`Spotify: ${r.meta.artists.join(", ")} — ${r.meta.title} (${r.meta.type})`);
  lines.push(r.target ? `→ ${r.service}: ${r.target}` : `→ stays on Spotify (${r.reason})`);
  $("out").textContent = lines.join("\n");
});

$("clear").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ cmd: "clearCache" });
  $("out").textContent = "Cache cleared.";
});

const SITE_ACCESS = { origins: browser.runtime.getManifest().host_permissions };
async function showAccess() {
  $("access").hidden = await browser.permissions.contains(SITE_ACCESS);
}
$("grant").addEventListener("click", async () => {
  await browser.permissions.request(SITE_ACCESS); // straight from the click, no await before
  showAccess();
});
browser.permissions.onAdded.addListener(showAccess);
browser.permissions.onRemoved.addListener(showAccess);

showAccess();
load();
