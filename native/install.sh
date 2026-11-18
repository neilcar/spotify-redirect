#!/usr/bin/env bash
# Installs the TIDAL autoplay helper for the Spotify → Bandcamp / Tidal extension (macOS).
#   bash native/install.sh            install or update
#   bash native/install.sh uninstall  remove everything this script added
#
# Adds:
#   ~/Library/Application Support/spotify-redirect/   the helper (tidal-play.mjs + wrapper)
#   <Firefox and Zen>/NativeMessagingHosts/spotify_redirect_tidal.json
#   ~/Applications/TIDAL (autoplay).app               starts TIDAL with its debug port on
set -euo pipefail

NAME=spotify_redirect_tidal
EXT_ID=spotify-redirect@neilcar.local
PORT=47320
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/Library/Application Support/spotify-redirect"
HOST_DIRS=(
  "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"   # Firefox
  "$HOME/Library/Application Support/zen/NativeMessagingHosts"       # Zen
)
LAUNCHER="$HOME/Applications/TIDAL (autoplay).app"

if [[ "${1:-}" == "uninstall" ]]; then
  for d in "${HOST_DIRS[@]}"; do rm -f "$d/$NAME.json"; done
  rm -rf "$DEST" "$LAUNCHER"
  echo "Removed the helper, its native messaging manifests and the launcher."
  exit 0
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node not found on PATH (needs Node 22 or later)" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "node $NODE_MAJOR is too old (needs 22+, for the built-in WebSocket)" >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$HERE/tidal-play.mjs" "$DEST/tidal-play.mjs"
# Firefox starts the helper with a bare environment, so the wrapper names node by full path.
cat > "$DEST/tidal-play" <<EOF
#!/bin/sh
exec "$NODE" "$DEST/tidal-play.mjs"
EOF
chmod 755 "$DEST/tidal-play"

for d in "${HOST_DIRS[@]}"; do
  mkdir -p "$d"
  cat > "$d/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Plays Tidal links in the TIDAL desktop app for the Spotify → Bandcamp / Tidal extension",
  "path": "$DEST/tidal-play",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF
done

mkdir -p "$HOME/Applications"
rm -rf "$LAUNCHER"
osacompile -o "$LAUNCHER" -e "do shell script \"/usr/bin/open -a TIDAL --args --remote-debugging-port=$PORT\""
# Use TIDAL's own icon for the launcher.
cp "/Applications/TIDAL.app/Contents/Resources/icon.icns" "$LAUNCHER/Contents/Resources/applet.icns" 2>/dev/null || true
touch "$LAUNCHER"

echo "Installed:"
echo "  helper    $DEST/tidal-play (node $("$NODE" -v))"
for d in "${HOST_DIRS[@]}"; do echo "  manifest  $d/$NAME.json"; done
echo "  launcher  $LAUNCHER"
echo
echo "Start TIDAL with the launcher (put it in the Dock instead of TIDAL) so links can autoplay."
echo "Then turn on \"Autoplay in TIDAL\" on the extension's options page."
