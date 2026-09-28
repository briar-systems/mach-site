#!/usr/bin/env node
// a stand-in for the two github endpoints the catalog refresh reads, for
// checking the server without reaching github: GET /entries.json answers a
// mach-ecosystem listing read from a file on every request, so a test can
// merge an entry by rewriting it, and POST /graphql answers repository
// metadata for the aliases the query names, requiring the bearer token given.
// usage: node test/stub/github.js <port> <token> <listing.json>
// it logs one line per request to stdout, so a test can count the calls.
"use strict";

const fs = require("node:fs");
const http = require("node:http");

const REPOS = {
  "briar-systems/mach": { stars: 137, forks: 5, pushed: "2026-09-27T10:33:26Z", license: { spdxId: "MIT", name: "MIT License" }, release: { tagName: "v6.6.0", publishedAt: "2026-09-28T05:48:18Z" } },
  "briar-systems/hedge": { stars: 1234, forks: 9, pushed: "2026-09-20T00:00:00Z", license: { spdxId: "NOASSERTION", name: "Other" }, release: null },
  "someone/zeta": { stars: 12, forks: 1, pushed: "2025-01-02T03:04:05Z", license: null, release: { tagName: "v0.1.0", publishedAt: "2025-01-01T00:00:00Z" } },
};

function repository(owner, name) {
  const key = `${owner}/${name}`;
  const r = REPOS[key];
  if (!r) { return null; }
  return {
    nameWithOwner: key,
    stargazerCount: r.stars,
    forkCount: r.forks,
    pushedAt: r.pushed,
    owner: { login: owner },
    licenseInfo: r.license,
    latestRelease: r.release,
  };
}

function main() {
  const port = Number(process.argv[2]);
  const token = process.argv[3];
  const listing = process.argv[4];
  http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      console.log(`${req.method} ${req.url}`);
      if (req.method === "GET" && req.url === "/entries.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fs.readFileSync(listing));
        return;
      }
      if (req.method === "POST" && req.url === "/graphql") {
        if (req.headers.authorization !== `bearer ${token}`) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end('{"message":"Bad credentials"}');
          return;
        }
        let query;
        try { query = JSON.parse(Buffer.concat(chunks).toString()).query; } catch (e) { query = null; }
        if (typeof query !== "string") {
          res.writeHead(400);
          res.end();
          return;
        }
        const data = {};
        const errors = [];
        const re = /(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g;
        let m;
        while ((m = re.exec(query))) {
          data[m[1]] = repository(m[2], m[3]);
          if (!data[m[1]]) { errors.push({ type: "NOT_FOUND", path: [m[1]] }); }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(errors.length ? { data, errors } : { data }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  }).listen(port, "127.0.0.1");
}

main();
