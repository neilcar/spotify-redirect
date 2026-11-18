// Writes dist/updates.json, the self-hosted update manifest Firefox polls at the manifest's
// update_url (the latest GitHub Release). It names this version and its signed .xpi.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO = "neilcar/spotify-redirect";

export function xpiName(version) {
  return `spotify-redirect-${version}.xpi`;
}

export function updatesJson(manifest) {
  const gecko = manifest.browser_specific_settings.gecko;
  const v = manifest.version;
  return {
    addons: {
      [gecko.id]: {
        updates: [
          {
            version: v,
            update_link: `https://github.com/${REPO}/releases/download/v${v}/${xpiName(v)}`,
            applications: { gecko: { strict_min_version: gecko.strict_min_version } },
          },
        ],
      },
    },
  };
}

// Compare paths, not URLs: the installed helper lives under "Application Support" (a space).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url)));
  mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../dist/updates.json", import.meta.url), JSON.stringify(updatesJson(manifest), null, 2) + "\n");
  console.log(`dist/updates.json -> ${xpiName(manifest.version)}`);
}
