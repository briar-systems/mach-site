#!/usr/bin/env node
// packs the libraries the playground's compiler builds against into one json
// map, { name: { path: text } }: each library's manifest and its .mach
// sources, as the browser's in-memory filesystem mounts them under /dep.
//
// usage: build-playground-libs.js [out.json] [name=dir ...]
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
// the libraries a playground project can import, each at the commit dep/ pins
const LIBS = ["std", "shader"];

function collect(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collect(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile() && entry.name.endsWith(".mach")) {
      out[rel] = fs.readFileSync(path.join(dir, entry.name), "utf8");
    }
  }
}

// one library: its manifest, and every source under the src it names
function packLib(dir) {
  const manifest = fs.readFileSync(path.join(dir, "mach.toml"), "utf8");
  const files = { "mach.toml": manifest };
  collect(path.join(dir, "src"), "src", files);
  return files;
}

function packLibs(dirs) {
  const out = {};
  for (const name of Object.keys(dirs).sort()) { out[name] = packLib(dirs[name]); }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const outFile = path.resolve(args.find((a) => !a.includes("=")) || path.join(ROOT, "public", "playground", "libs.json"));
  const dirs = {};
  for (const name of LIBS) { dirs[name] = path.join(ROOT, "dep", name); }
  for (const pair of args.filter((a) => a.includes("="))) {
    dirs[pair.slice(0, pair.indexOf("="))] = path.resolve(pair.slice(pair.indexOf("=") + 1));
  }
  const json = JSON.stringify(packLibs(dirs));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, json);
  const count = Object.values(JSON.parse(json)).reduce((n, files) => n + Object.keys(files).length, 0);
  console.log(`built ${outFile}: ${Object.keys(dirs).join(", ")}, ${count} files, ${(Buffer.byteLength(json) / 1024).toFixed(0)} KiB`);
}

if (require.main === module) { main(); }

module.exports = { packLibs };
