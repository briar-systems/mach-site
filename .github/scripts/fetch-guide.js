#!/usr/bin/env node
// fetches mach's guide, doc/guide in the mach repository, for every release
// the site documents: the newest patch of each minor from the first release
// that carries a guide. each lands in <out>/<version>/ as build-docs.js reads
// it: nav.json and the pages it names.
//
// usage: fetch-guide.js [out dir] [--refs <file>] [<ref>=<version> ...]
// --refs reads the repository's ref advertisement from a file, as the image
// build does. a <ref>=<version> fetches that branch or tag as that release in
// place of the tags, to see a guide before its release
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const REPO = "briar-systems/mach";
// what git itself asks a repository for its refs
const REFS_URL = `https://github.com/${REPO}.git/info/refs?service=git-upload-pack`;
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const GUIDE = "doc/guide";
// the first release whose tag holds doc/guide
const FIRST = [7, 3, 0];

function older(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// the releases to document, newest first, from a ref advertisement: every
// vX.Y.Z tag from the first with a guide, and of each minor its newest patch
function pick(advertisement) {
  const newest = new Map();
  for (const m of advertisement.matchAll(/refs\/tags\/v(\d+)\.(\d+)\.(\d+)(?![\w.-])/g)) {
    const version = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (older(version, FIRST) < 0) { continue; }
    const key = version[0] + "." + version[1];
    if (!newest.has(key) || older(newest.get(key), version) < 0) { newest.set(key, version); }
  }
  return Array.from(newest.values()).sort((a, b) => older(b, a)).map((v) => v.join("."));
}

// how often a request is made before its failure stands
const TRIES = 4;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// a file's text. a request the network dropped, or one the server asks to be
// made again, is made again, each time further apart. an answer that says the
// file is not there stands at once
async function text(get, url, wait = pause) {
  for (let attempt = 1; ; attempt++) {
    let res = null;
    let dropped = null;
    try {
      res = await get(url);
      if (res.ok) { return await res.text(); }
    } catch (e) {
      res = null;
      dropped = e;
    }
    const again = !res || res.status === 429 || res.status >= 500;
    if (!again || attempt === TRIES) {
      if (res) { throw new Error(`${url} answered ${res.status}`); }
      throw new Error(`${url} could not be fetched: ${(dropped.cause && (dropped.cause.code || dropped.cause.message)) || dropped.message}`);
    }
    await wait(250 * 2 ** (attempt - 1));
  }
}

// one release's guide at a ref: nav.json, then every page it lists
async function fetchGuide(get, ref, wait = pause) {
  const base = `${RAW}/${ref}/${GUIDE}`;
  const nav = await text(get, `${base}/nav.json`, wait);
  const names = JSON.parse(nav).groups.flatMap((g) => g.pages);
  const bodies = await Promise.all(names.map((name) => text(get, `${base}/${name}.md`, wait)));
  return { nav, pages: names.map((name, n) => ({ name, body: bodies[n] })) };
}

async function main(argv, get) {
  const args = argv.slice();
  const at = args.indexOf("--refs");
  const refsFile = at === -1 ? null : args.splice(at, 2)[1];
  const named = args.filter((a) => a.includes("="));
  const out = path.resolve(args.find((a) => !a.includes("=")) || path.join(ROOT, "out", "guide"));
  // version -> the ref it is read from
  const wanted = new Map();
  for (const pair of named) {
    const cut = pair.lastIndexOf("=");
    wanted.set(pair.slice(cut + 1), pair.slice(0, cut));
  }
  if (!named.length) {
    const advertisement = refsFile ? fs.readFileSync(refsFile, "latin1") : await text(get, REFS_URL);
    for (const version of pick(advertisement)) { wanted.set(version, "v" + version); }
    if (!wanted.size) { throw new Error(`no mach release holds a guide: the first is ${FIRST.join(".")}`); }
  }
  // every release is in hand before the directory is touched, so a fetch that
  // fails leaves what was there
  const fetched = [];
  for (const [version, ref] of wanted) { fetched.push({ version, ref, guide: await fetchGuide(get, ref) }); }
  fs.rmSync(out, { recursive: true, force: true });
  for (const { version, ref, guide } of fetched) {
    const dir = path.join(out, version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "nav.json"), guide.nav);
    for (const page of guide.pages) { fs.writeFileSync(path.join(dir, page.name + ".md"), page.body); }
    console.log(`fetched the guide of ${version} from ${ref}: ${guide.pages.length} pages`);
  }
  // a release read from a branch has no tag for its links into the repository to open at
  const refs = Object.fromEntries(Array.from(wanted).filter(([version, ref]) => ref !== "v" + version));
  if (Object.keys(refs).length) { fs.writeFileSync(path.join(out, "refs.json"), JSON.stringify(refs) + "\n"); }
}

if (require.main === module) {
  main(process.argv.slice(2), fetch).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { pick, fetchGuide, main };
