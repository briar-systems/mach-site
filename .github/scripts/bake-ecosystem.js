#!/usr/bin/env node
// bake ecosystem/data.json from mach-ecosystem's entries.json plus github repo
// metadata. needs node 20+ and GH_TOKEN (any token that can read public repos).
// ENTRIES_URL overrides the listing source with a url or a local path.
// metadata is enrichment: an entry outside github, or one github no longer
// resolves, is baked without it and the latter gets a warning annotation.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOURCE = "https://github.com/briar-systems/mach-ecosystem";
const DEFAULT_ENTRIES = "https://raw.githubusercontent.com/briar-systems/mach-ecosystem/main/entries.json";
const GRAPHQL_URL = "https://api.github.com/graphql";
const OFFICIAL_OWNER = "briar-systems";
const CHUNK = 50;

const REPO_FIELDS = `
  nameWithOwner
  stargazerCount
  forkCount
  pushedAt
  owner { login }
  licenseInfo { spdxId name }
  latestRelease { tagName publishedAt }`;

// { owner, name } for a github repository url, or null for anything else
function githubRepo(url) {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m ? { owner: m[1], name: m[2] } : null;
}

// one graphql document fetching every repo under an alias r<i>
function metadataQuery(repos) {
  const parts = repos.map(
    (r, i) => `r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) {${REPO_FIELDS}\n}`,
  );
  return `query {\n${parts.join("\n")}\n}`;
}

function license(info) {
  if (!info) { return null; }
  // github reports NOASSERTION for a license file it cannot classify
  return info.spdxId && info.spdxId !== "NOASSERTION" ? info.spdxId : info.name || null;
}

function metadata(repo) {
  return {
    repo: repo.nameWithOwner,
    owner: repo.owner.login,
    stars: repo.stargazerCount,
    forks: repo.forkCount,
    pushed: repo.pushedAt,
    license: license(repo.licenseInfo),
    release: repo.latestRelease
      ? { tag: repo.latestRelease.tagName, published: repo.latestRelease.publishedAt }
      : null,
  };
}

// the baked document. `found` maps an entry id to its raw graphql repository
// object; entries without one carry github: null.
function merge(listing, found, generated) {
  const entries = listing.entries.map((e) => {
    const repo = found[e.id];
    const github = repo ? metadata(repo) : null;
    return {
      id: e.id,
      name: e.name,
      url: e.url,
      description: e.description,
      category: e.category,
      official: github ? github.owner.toLowerCase() === OFFICIAL_OWNER : false,
      github,
    };
  });
  const used = new Set(entries.map((e) => e.category));
  return {
    generated,
    source: SOURCE,
    categories: listing.categories.filter((c) => used.has(c.id)),
    entries,
  };
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) { throw new Error(`${url} returned ${res.status}`); }
  return res.json();
}

async function fetchMetadata(targets, token) {
  const found = {};
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const body = await fetchJson(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: metadataQuery(chunk.map((t) => t.repo)) }),
    });
    // a repo that no longer resolves comes back as a null alias plus an error
    // entry, while anything else wrong with the request has no data at all
    if (!body.data) { throw new Error(`graphql: ${JSON.stringify(body.errors)}`); }
    chunk.forEach((t, j) => {
      const repo = body.data[`r${j}`];
      if (repo) {
        found[t.id] = repo;
      } else {
        console.log(`::warning::${t.id}: github did not resolve ${t.repo.owner}/${t.repo.name}, baked without metadata`);
      }
    });
  }
  return found;
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) { throw new Error("GH_TOKEN is not set"); }
  const out = process.argv[2] || path.join(__dirname, "..", "..", "ecosystem", "data.json");

  const from = process.env.ENTRIES_URL || DEFAULT_ENTRIES;
  const listing = /^https?:/.test(from) ? await fetchJson(from) : JSON.parse(fs.readFileSync(from, "utf8"));
  if (!Array.isArray(listing.entries) || !Array.isArray(listing.categories)) {
    throw new Error(`${from} is not a mach-ecosystem listing`);
  }
  const targets = listing.entries
    .map((e) => ({ id: e.id, repo: githubRepo(e.url) }))
    .filter((t) => t.repo);
  const found = await fetchMetadata(targets, token);
  const doc = merge(listing, found, new Date().toISOString());

  fs.writeFileSync(out, JSON.stringify(doc) + "\n");
  console.log(`baked ${doc.entries.length} entries (${Object.keys(found).length} with github metadata) into ${out}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { githubRepo, metadataQuery, merge };
