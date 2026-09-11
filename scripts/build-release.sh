#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$PROJECT_DIR/manifest.json').version")
RELEASE_DIR="$PROJECT_DIR/dist"
RELEASE_ZIP="$RELEASE_DIR/vinted-republish-free-$VERSION.zip"
RELEASE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/vinted-republish.XXXXXX")
trap 'rm -rf -- "$RELEASE_TMP"' EXIT HUP INT TERM

mkdir -p "$RELEASE_DIR"
for OLD_RELEASE in "$RELEASE_DIR"/relister-for-vinted-*.zip "$RELEASE_DIR"/vinted-republish-*.zip; do
  [ -e "$OLD_RELEASE" ] || continue
  [ "$OLD_RELEASE" = "$RELEASE_ZIP" ] || rm -f -- "$OLD_RELEASE"
done
cp "$PROJECT_DIR/manifest.json" "$RELEASE_TMP/"
cp "$PROJECT_DIR/background.js" "$RELEASE_TMP/"
cp "$PROJECT_DIR/options.html" "$RELEASE_TMP/"
for UI_FILE in welcome.html pending.html transfert.html transfer-ui.js transfer.css popup.html logs.html logs-ui.js ui.js ui.css; do
  cp "$PROJECT_DIR/$UI_FILE" "$RELEASE_TMP/"
done
cp "$PROJECT_DIR/privacy.html" "$RELEASE_TMP/"
cp -R "$PROJECT_DIR/_locales" "$RELEASE_TMP/"
cp -R "$PROJECT_DIR/icons" "$RELEASE_TMP/"
cp -R "$PROJECT_DIR/media" "$RELEASE_TMP/"
cp -R "$PROJECT_DIR/src" "$RELEASE_TMP/"

rm -f -- "$RELEASE_ZIP"
(cd "$RELEASE_TMP" && zip -q -r "$RELEASE_ZIP" manifest.json background.js options.html welcome.html pending.html transfert.html transfer-ui.js transfer.css popup.html logs.html logs-ui.js ui.js ui.css privacy.html _locales icons media src)

printf '%s\n' "$RELEASE_ZIP"
