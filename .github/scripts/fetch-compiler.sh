#!/bin/sh
# fetches one archive of a mach release and unpacks it into a directory. the
# archive must hash to the sha256 given, and the release's SHA256SUMS must list
# it under that same sum, or nothing is unpacked.
# usage: fetch-compiler.sh <version> <platform> <sha256> <dir>
#   fetch-compiler.sh 7.3.0 wasm32-wasi 5ab1... out/wasm
set -eu

version=$1
platform=$2
sum=$3
dir=$4

archive="mach-$version-$platform.tar.gz"
base="https://github.com/briar-systems/mach/releases/download/v$version"

mkdir -p "$dir"
cd "$dir"
curl -fsSLO --retry 3 "$base/$archive"
curl -fsSLO --retry 3 "$base/SHA256SUMS"
grep -qx "$sum  $archive" SHA256SUMS
echo "$sum  $archive" | sha256sum -c -
tar -xzf "$archive"
