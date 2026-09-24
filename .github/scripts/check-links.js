#!/usr/bin/env node
// check every link in the given markdown files (default llms.txt and llms-full.txt).
// a link is a markdown link target or a bare url in prose, outside code. machlang.org
// urls resolve against this checkout, fragments included, since the files ship with
// it. every other url must answer 2xx over http after redirects. exits 1 on any failure.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { mapText, parse } = require("./build-llms.js");

const SITE_HOST = "machlang.org";
const CONCURRENCY = 8;
const ATTEMPTS = 3;
const TIMEOUT_MS = 20000;

// every url a markdown document links, in first-seen order
function links(md) {
  const found = [];
  const add = (u) => {
    const url = u.replace(/[.,;:!?]+$/, "");
    if (!found.includes(url)) { found.push(url); }
  };
  mapText(md, (seg) => {
    for (const m of seg.matchAll(/\]\(([^)\s]+)\)/g)) { add(m[1]); }
    for (const m of seg.replace(/\]\([^)\s]+\)/g, "]").matchAll(/https?:\/\/[^\s<>()"'`]+/g)) { add(m[0]); }
    return seg;
  });
  return found;
}

// the file a machlang.org path serves from the checkout
function localFile(root, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) { rel += "index.html"; }
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) { return null; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) { return path.join(file, "index.html"); }
  return file;
}

const idCache = new Map();
function ids(file) {
  if (!idCache.has(file)) {
    const set = new Set();
    const walk = (n) => {
      if (typeof n === "string") { return; }
      if (n.attrs.id) { set.add(n.attrs.id); }
      n.children.forEach(walk);
    };
    walk(parse(fs.readFileSync(file, "utf8")));
    idCache.set(file, set);
  }
  return idCache.get(file);
}

function checkLocal(root, url) {
  const file = localFile(root, url.pathname);
  if (!file || !fs.existsSync(file)) { return `no file in the checkout for ${url.pathname}`; }
  const frag = decodeURIComponent(url.hash.slice(1));
  if (frag && file.endsWith(".html") && !ids(file).has(frag)) { return `no id "${frag}" in ${path.relative(root, file)}`; }
  return null;
}

async function request(url, method) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: ctl.signal, headers: { "User-Agent": "machlang.org link check" } });
    await res.body?.cancel();
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

async function checkRemote(url) {
  let last = "";
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      let status = await request(url, "HEAD");
      // some hosts refuse or mishandle HEAD, so confirm a failure with GET
      if (status >= 400) { status = await request(url, "GET"); }
      if (status >= 200 && status < 300) { return null; }
      last = `http ${status}`;
      if (status < 500 && status !== 429) { return last; }
    } catch (e) {
      last = e.name === "AbortError" ? "timed out" : e.message;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  return last;
}

async function check(root, urls) {
  const failures = [];
  const queue = [...urls];
  const remote = new Map();
  async function worker() {
    for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
      let url;
      try {
        url = new URL(u);
      } catch {
        failures.push({ url: u, why: "not an absolute url" });
        continue;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") { failures.push({ url: u, why: `unsupported scheme ${url.protocol}` }); continue; }
      let why;
      if (url.hostname === SITE_HOST) {
        why = checkLocal(root, url);
      } else {
        // fragments do not reach the server, so one request covers every anchor on a page
        const key = url.href.replace(/#.*$/, "");
        if (!remote.has(key)) { remote.set(key, checkRemote(key)); }
        why = await remote.get(key);
      }
      if (why) { failures.push({ url: u, why }); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return failures;
}

async function main() {
  const root = path.resolve(__dirname, "..", "..");
  const files = process.argv.slice(2);
  const targets = files.length ? files : ["llms.txt", "llms-full.txt"].map((f) => path.join(root, f));
  const urls = [];
  for (const f of targets) {
    for (const u of links(fs.readFileSync(f, "utf8"))) { if (!urls.includes(u)) { urls.push(u); } }
  }
  const failures = await check(root, urls);
  for (const f of failures) { console.error(`broken: ${f.url} (${f.why})`); }
  console.log(`checked ${urls.length} links in ${targets.map((t) => path.basename(t)).join(", ")}: ${failures.length} broken`);
  if (failures.length) { process.exit(1); }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { links, localFile, checkLocal };
