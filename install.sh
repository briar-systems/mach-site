#!/bin/sh
url="https://raw.githubusercontent.com/octalide/mach/main/dist/install.sh"
script=$(curl -fsSL "$url") || { echo "error: failed to fetch mach installer from $url" >&2; exit 1; }
printf '%s\n' "$script" | sh -s -- "$@"
