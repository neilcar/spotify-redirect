// Fails unless the git tag (GITHUB_REF_NAME, e.g. v1.2.2) matches src/manifest.json's version.
import { readFileSync } from "node:fs";
const version = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url))).version;
const tag = process.env.GITHUB_REF_NAME || process.argv[2] || "";
if (tag !== `v${version}`) {
  console.error(`tag "${tag}" does not match manifest version ${version} (expected v${version})`);
  process.exit(1);
}
console.log(`tag ${tag} matches manifest version ${version}`);
