#!/usr/bin/env bash
# Copy the static web app into a publish directory (data is built separately).
# Usage: tools/assemble_site.sh _site
set -euo pipefail
out="${1:-_site}"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
cp "$root/index.html" "$root/manifest.webmanifest" "$out/"
cp -r "$root/css" "$root/js" "$root/img" "$root/vendor" "$out/"
touch "$out/.nojekyll"
echo "site assembled in $out"
