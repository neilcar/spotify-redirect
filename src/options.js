const $ = (id) => document.getElementById(id);
const FIELDS = ["tidalClientId", "tidalClientSecret", "countryCode"];
const SELECTS = { tidalOpenIn: "app" };

async function load() {
  const s = await browser.storage.local.get(["enabled", "order", ...FIELDS]);
  $("enabled").checked = s.enabled !== false;
  $("order").value = (s.order || ["bandcamp", "tidal"]).join(",");
  const sel = await browser.storage.local.get(Object.keys(SELECTS));
  for (const [k, d] of Object.entries(SELECTS)) $(k).value = sel[k] || d;
  for (const f of FIELDS) $(f).value = s[f] || (f === "countryCode" ? "US" : "");
}

function save() {
  return browser.storage.local.set({
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

load();
