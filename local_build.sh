#!/bin/bash
#
# Local dev build for GOTTA.BIKE Sauce Lunatic.
#
#   ./local_build.sh              build zip + install into ~/Documents/SauceMods
#   ./local_build.sh --no-install build the zip only
#
# The version is whatever manifest.json says -- this script never rewrites it.
# Releases are cut by tagging (see .github/workflows/release.yml), and CI
# refuses to publish if the tag and the manifest disagree, so there is exactly
# one source of truth for the version.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FOLDER_NAME="GOTTA_BIKE_Sauce_Lunatic"
BUILD_DIR="build"
OUTPUT_DIR="$BUILD_DIR/$FOLDER_NAME"

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
echo "Version: $VERSION"

# Fail fast on a broken manifest or a syntax error, rather than shipping it.
python3 -c "import json;json.load(open('manifest.json'))"
find pages/src -name '*.mjs' -exec node --check {} \;

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp manifest.json "$OUTPUT_DIR/"
cp -r pages "$OUTPUT_DIR/"
[ -f LICENSE ] && cp LICENSE "$OUTPUT_DIR/"
find "$OUTPUT_DIR" -name '.DS_Store' -delete

ZIP="${FOLDER_NAME}_${VERSION}.zip"
rm -f "$BUILD_DIR/$ZIP"
( cd "$BUILD_DIR" && zip -qr "$ZIP" "$FOLDER_NAME" )

if [ "${1:-}" != "--no-install" ]; then
    MODS_DIR="$HOME/Documents/SauceMods"
    if [ -d "$MODS_DIR" ]; then
        # Replace rather than merge, so removed/renamed files don't linger.
        rm -rf "${MODS_DIR:?}/$FOLDER_NAME"
        cp -r "$OUTPUT_DIR" "$MODS_DIR/"
        echo "Installed to $MODS_DIR/$FOLDER_NAME"
    else
        echo "WARNING: $MODS_DIR not found - skipped install"
    fi
fi

echo ""
echo "Build complete!"
echo "  Version: $VERSION"
echo "  Zip:     $BUILD_DIR/$ZIP"
