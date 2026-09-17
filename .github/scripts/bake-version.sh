#!/bin/sh
# replace the version placeholder in assets/version.js with the latest mach release.
# needs gh with a token that can read briar-systems/mach releases.
set -eu

file="${1:-assets/version.js}"
placeholder="@MACH_VERSION@"

tag=$(gh release view -R briar-systems/mach --json tagName --jq .tagName)
ver=${tag#v}
if ! printf '%s\n' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: latest mach release tag '$tag' is not vX.Y.Z" >&2
  exit 1
fi

if ! grep -q "$placeholder" "$file"; then
  echo "error: $file has no $placeholder placeholder" >&2
  exit 1
fi

sed "s/$placeholder/$ver/g" "$file" > "$file.tmp"
mv "$file.tmp" "$file"

if grep -q "$placeholder" "$file" || ! grep -q "MACH_VERSION = \"$ver\"" "$file"; then
  echo "error: $file did not take version $ver" >&2
  exit 1
fi

echo "baked mach $ver into $file"
