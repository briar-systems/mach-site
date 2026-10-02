// run against a running server image whose catalog settings point at the stub
// this test starts (test/stub/github.js), and which has no catalog on its
// volume yet:
//   SITE_URL=http://127.0.0.1:8080 STUB_PORT=18212 STUB_TOKEN=test-token \
//   WEBHOOK_SECRET=test-secret node --test test/catalog.test.js
// it checks the cold start, the webhook's signature check, the refresh, the
// json, the page with and without filters, that serving the page never calls
// github, and that a merged entry shows once the webhook fires.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BASE = process.env.SITE_URL;
const PORT = process.env.STUB_PORT;
const TOKEN = process.env.STUB_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;
const FIXTURE = path.join(__dirname, "stub", "entries.json");

function request(method, urlPath, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(urlPath, BASE), { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function sign(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function hook(body, signature) {
  const headers = { "content-type": "application/json", "x-github-event": "push" };
  if (signature) { headers["x-hub-signature-256"] = signature; }
  return request("POST", "/hooks/ecosystem", headers, body);
}

// the catalog's document once `ready` accepts it, polling for up to 10 seconds
async function catalogWhen(ready) {
  const until = Date.now() + 10000;
  for (;;) {
    const res = await request("GET", "/ecosystem.json");
    if (res.status === 200) {
      const doc = JSON.parse(res.body);
      if (ready(doc)) { return doc; }
    }
    if (Date.now() > until) { throw new Error("the catalog did not refresh within 10 seconds"); }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function cards(html) {
  return [...html.matchAll(/<a class="eco-name" href="[^"]*"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
}

let stub = null;
let calls = 0;
let listing = null;

test.before(() => {
  assert.ok(BASE && PORT && TOKEN && SECRET, "set SITE_URL, STUB_PORT, STUB_TOKEN and WEBHOOK_SECRET");
  const dir = fs.mkdtempSync(path.join(__dirname, "..", "out", "catalog-"));
  listing = path.join(dir, "entries.json");
  fs.copyFileSync(FIXTURE, listing);
});

test.after(() => {
  if (stub) { stub.kill(); }
});

test("a cold start with github unreachable serves the unavailable notice", async () => {
  const page = await request("GET", "/ecosystem/");
  assert.equal(page.status, 200);
  assert.match(page.body, /The catalog is unavailable right now/);
  assert.match(page.body, /id="eco-data">null<\/script>/);
  const json = await request("GET", "/ecosystem.json");
  assert.equal(json.status, 503);
  const health = await request("GET", "/healthz", { host: "healthcheck.railway.app" });
  assert.equal(health.status, 200);
  assert.equal(health.body, "ok\ncatalog_generated none\nllms_version none\n");
});

test("the stub starts", async () => {
  stub = spawn(process.execPath, [path.join(__dirname, "stub", "github.js"), PORT, TOKEN, listing]);
  stub.stdout.on("data", (d) => { calls += d.toString().split("\n").filter(Boolean).length; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(stub.exitCode, null);
});

test("unsigned and mis-signed webhook calls are refused", async () => {
  const body = '{"ref":"refs/heads/main"}';
  for (const signature of [null, sign(body, "not-the-secret"), "sha256=zz", sign(body + " ", SECRET)]) {
    const res = await hook(body, signature);
    assert.equal(res.status, 401, String(signature));
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls, 0, "a refused webhook reached github");
});

test("a signed webhook refreshes the catalog within seconds", async () => {
  const body = '{"ref":"refs/heads/main"}';
  const res = await hook(body, sign(body, SECRET));
  assert.equal(res.status, 202);
  const doc = await catalogWhen((d) => d.entries.length === 5);
  assert.equal(doc.stale, false);
  assert.deepEqual(doc.categories.map((c) => c.id), ["core", "web"]);
  const byId = Object.fromEntries(doc.entries.map((e) => [e.id, e]));
  assert.equal(byId.mach.official, true);
  assert.deepEqual(byId.mach.github, { repo: "briar-systems/mach", owner: "briar-systems", stars: 137, forks: 5, pushed: "2026-09-27T10:33:26Z", license: "MIT", release: { tag: "v6.6.0", published: "2026-09-28T05:48:18Z" } });
  assert.equal(byId.hedge.github.license, "Other");
  assert.equal(byId.zeta.official, false);
  assert.equal(byId.zeta.archived, true);
  assert.equal(byId.hedge.archived, false);
  assert.equal(byId.zeta.github.license, null);
  assert.equal(byId.gone.github, null);
  assert.equal(byId.elsewhere.github, null);
  assert.equal(calls, 2, "one listing fetch and one metadata query");
});

test("the json carries an etag and a short cache lifetime, and revalidates", async () => {
  const res = await request("GET", "/ecosystem.json");
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(res.headers["cache-control"], "public, max-age=60");
  assert.ok(res.headers.etag);
  const again = await request("GET", "/ecosystem.json", { "if-none-match": res.headers.etag });
  assert.equal(again.status, 304);
  const head = await request("HEAD", "/ecosystem.json");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], String(Buffer.byteLength(res.body)));
});

test("the page holds every card and filters without javascript", async () => {
  const all = await request("GET", "/ecosystem/");
  assert.equal(all.status, 200);
  assert.equal(all.headers["content-type"], "text/html; charset=utf-8");
  assert.deepEqual(cards(all.body), ["hedge", "mach", "Zeta", "elsewhere", "gone"]);
  assert.match(all.body, /An HTTP server &lt;written&gt; in Mach\./);
  assert.match(all.body, /showing all 5 projects/);
  assert.equal(all.body.match(/aria-label="archived"/g).length, 1);
  assert.match(all.body, /Zeta<\/a><div class="eco-tags"><span class="eco-archived" role="img" aria-label="archived" title="archived/);
  const embedded = /<script type="application\/json" id="eco-data">([^<]*)<\/script>/.exec(all.body);
  assert.equal(JSON.parse(embedded[1]).entries.length, 5);

  const views = {
    "?q=WEB&sort=name": ["elsewhere", "gone", "hedge", "Zeta"],
    "?category=core": ["mach"],
    "?source=community": ["Zeta", "elsewhere", "gone"],
    "?sort=release": ["mach", "Zeta", "elsewhere", "gone", "hedge"],
    "?sort=updated&source=official": ["mach", "hedge"],
    "?q=nothing+matches": [],
  };
  for (const [query, want] of Object.entries(views)) {
    const res = await request("GET", "/ecosystem/" + query);
    assert.equal(res.status, 200, query);
    assert.deepEqual(cards(res.body), want, query);
  }
  const moved = await request("GET", "/ecosystem?q=web");
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.location, "/ecosystem/?q=web");
});

test("serving the page does not call github", async () => {
  const before = calls;
  for (let round = 0; round < 10; round++) {
    await Promise.all(Array.from({ length: 20 }, () => request("GET", "/ecosystem/?q=mach")));
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls, before);
});

test("an entry merged into the listing shows once the webhook fires", async () => {
  const doc = JSON.parse(fs.readFileSync(listing, "utf8"));
  doc.entries.push({ id: "fresh", name: "fresh", url: "https://example.org/fresh", description: "Just merged.", category: "games" });
  fs.writeFileSync(listing, JSON.stringify(doc));
  const body = '{"ref":"refs/heads/main"}';
  assert.equal((await hook(body, sign(body, SECRET))).status, 202);
  await catalogWhen((d) => d.entries.some((e) => e.id === "fresh"));
  const page = await request("GET", "/ecosystem/?category=games");
  assert.deepEqual(cards(page.body), ["fresh"]);
});

test("the health check reports the catalog's age", async () => {
  const res = await request("GET", "/healthz");
  assert.match(res.body, /^ok\ncatalog_generated \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\ncatalog_age_seconds \d+\ncatalog_stale false\nllms_version none\n$/);
});
