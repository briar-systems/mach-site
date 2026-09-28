// run against a running server image: SITE_URL=http://127.0.0.1:8080 node --test test/serve.test.js
// checks every file under public/, the llms files, the index and redirect
// paths, conditional and precompressed responses, the 404 page and the health
// check, as the container serves them. test/catalog.test.js checks the
// ecosystem routes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");

const PUBLIC = path.resolve(__dirname, "..", "public");
const BASE = process.env.SITE_URL;

const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  mach: "text/plain; charset=utf-8",
  sh: "application/x-sh",
  ps1: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
};
const COMPRESSED = new Set(["html", "css", "js", "json", "txt", "mach", "sh", "ps1", "svg"]);

// the cache-control hedge.toml assigns a path
function cacheControl(urlPath) {
  if (urlPath.endsWith(".html") || urlPath.endsWith("/")) { return "no-cache"; }
  if (urlPath === "/install.sh" || urlPath === "/install.ps1") { return "no-cache"; }
  if (/^\/assets\/[^/]+\.(png|svg)$/.test(urlPath)) { return "public, max-age=86400"; }
  return "public, max-age=600";
}

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(urlPath, BASE), { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

const served = files(PUBLIC)
  .map((f) => "/" + path.relative(PUBLIC, f).split(path.sep).join("/"))
  .filter((p) => !/\.(gz|br)$/.test(p) && p !== "/ecosystem/data.json" && !p.startsWith("/llms"));

test("SITE_URL names the server under test", () => {
  assert.ok(BASE, "set SITE_URL to the running server");
});

test("every file is served with its type, its caching and its bytes", async () => {
  for (const p of served) {
    const ext = p.slice(p.lastIndexOf(".") + 1);
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers["content-type"], TYPES[ext], `${p} type`);
    assert.equal(res.headers["cache-control"], cacheControl(p), `${p} cache-control`);
    assert.ok(res.headers.etag, `${p} etag`);
    assert.deepEqual(res.body, fs.readFileSync(path.join(PUBLIC, p)), `${p} bytes`);
  }
});

test("the llms files are served as text", async () => {
  for (const p of ["/llms.txt", "/llms-full.txt"]) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers["content-type"], TYPES.txt, p);
    assert.equal(res.headers["cache-control"], "public, max-age=600", p);
    assert.match(res.body.toString(), /^# Mach/, p);
  }
});

test("text files have gzip and brotli variants that decode to the file", async () => {
  for (const p of served.filter((p) => COMPRESSED.has(p.slice(p.lastIndexOf(".") + 1)))) {
    const want = fs.readFileSync(path.join(PUBLIC, p));
    for (const [coding, decode] of [["br", zlib.brotliDecompressSync], ["gzip", zlib.gunzipSync]]) {
      const res = await get(p, { "accept-encoding": coding });
      assert.equal(res.status, 200, `${p} ${coding}`);
      assert.equal(res.headers["content-encoding"], coding, `${p} ${coding}`);
      assert.match(res.headers.vary || "", /accept-encoding/i, `${p} ${coding} vary`);
      assert.equal(res.headers["content-type"], TYPES[p.slice(p.lastIndexOf(".") + 1)], `${p} ${coding} type`);
      assert.equal(res.headers["cache-control"], cacheControl(p), `${p} ${coding} cache-control`);
      assert.deepEqual(decode(res.body), want, `${p} ${coding} bytes`);
    }
  }
});

test("a matching etag is answered 304 with its caching", async () => {
  for (const p of ["/", "/style.css", "/assets/mach.svg", "/install.sh"]) {
    const first = await get(p);
    const again = await get(p, { "if-none-match": first.headers.etag });
    assert.equal(again.status, 304, p);
    assert.equal(again.body.length, 0, p);
    assert.equal(again.headers["cache-control"], cacheControl(p), p);
  }
});

test("directories serve their index and a bare directory redirects", async () => {
  for (const p of ["/", "/docs/"]) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers["content-type"], TYPES.html, p);
    assert.deepEqual(res.body, fs.readFileSync(path.join(PUBLIC, p, "index.html")), p);
  }
  for (const p of ["/docs"]) {
    const res = await get(p);
    assert.equal(res.status, 301, p);
    assert.equal(res.headers.location, `${p}/`, p);
  }
});

test("a missing path is the 404 page", async () => {
  const res = await get("/no/such/page");
  assert.equal(res.status, 404);
  assert.equal(res.headers["content-type"], TYPES.html);
  assert.equal(res.headers["cache-control"], undefined);
  assert.deepEqual(res.body, fs.readFileSync(path.join(PUBLIC, "404.html")));
});

test("the health check answers any host, the platform's included", async () => {
  for (const host of ["healthcheck.railway.app", "machlang.org"]) {
    const res = await get("/healthz", { host });
    assert.equal(res.status, 200, host);
    assert.match(res.body.toString(), /^ok\n/, host);
  }
});
