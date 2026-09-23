// run with: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const { githubRepo, metadataQuery, merge } = require("../.github/scripts/bake-ecosystem.js");
const page = require("../assets/ecosystem.js");

const LISTING = {
  categories: [
    { id: "web", title: "Web", description: "Servers." },
    { id: "empty", title: "Empty", description: "Nothing here." },
    { id: "net", title: "Networking", description: "Protocols." },
  ],
  entries: [
    { id: "hedge", name: "hedge", url: "https://github.com/briar-systems/hedge", description: "Web server.", category: "web" },
    { id: "far", name: "far", url: "https://codeberg.org/someone/far", description: "Hosted elsewhere.", category: "net" },
    { id: "gone", name: "gone", url: "https://github.com/someone/gone", description: "Deleted repo.", category: "net" },
    { id: "theirs", name: "theirs", url: "https://github.com/Someone/theirs", description: "Community project.", category: "net" },
  ],
};

function repo(owner, name, extra) {
  return Object.assign({
    nameWithOwner: owner + "/" + name,
    stargazerCount: 10,
    forkCount: 1,
    pushedAt: "2026-09-20T00:00:00Z",
    owner: { login: owner },
    licenseInfo: { spdxId: "MIT", name: "MIT License" },
    latestRelease: { tagName: "v1.0.0", publishedAt: "2026-09-01T00:00:00Z" },
  }, extra);
}

test("githubRepo takes only repository urls", () => {
  assert.deepEqual(githubRepo("https://github.com/a/b"), { owner: "a", name: "b" });
  assert.deepEqual(githubRepo("https://github.com/a/b/"), { owner: "a", name: "b" });
  assert.deepEqual(githubRepo("https://github.com/a/b.git"), { owner: "a", name: "b" });
  assert.equal(githubRepo("https://github.com/a"), null);
  assert.equal(githubRepo("https://github.com/a/b/tree/main"), null);
  assert.equal(githubRepo("https://codeberg.org/a/b"), null);
});

test("metadataQuery aliases each repo and escapes names", () => {
  const q = metadataQuery([{ owner: "a", name: "b" }, { owner: "c", name: 'd"e' }]);
  assert.match(q, /r0: repository\(owner: "a", name: "b"\)/);
  assert.match(q, /r1: repository\(owner: "c", name: "d\\"e"\)/);
});

test("merge attaches metadata, marks official repos, and drops empty categories", () => {
  const doc = merge(LISTING, {
    hedge: repo("briar-systems", "hedge"),
    theirs: repo("Someone", "theirs", { licenseInfo: { spdxId: "NOASSERTION", name: "Other" }, latestRelease: null }),
  }, "2026-09-23T00:00:00Z");

  assert.equal(doc.generated, "2026-09-23T00:00:00Z");
  assert.deepEqual(doc.categories.map((c) => c.id), ["web", "net"]);
  const by = Object.fromEntries(doc.entries.map((e) => [e.id, e]));

  assert.equal(by.hedge.official, true);
  assert.deepEqual(by.hedge.github, {
    repo: "briar-systems/hedge",
    owner: "briar-systems",
    stars: 10,
    forks: 1,
    pushed: "2026-09-20T00:00:00Z",
    license: "MIT",
    release: { tag: "v1.0.0", published: "2026-09-01T00:00:00Z" },
  });

  assert.equal(by.theirs.official, false);
  assert.equal(by.theirs.github.license, "Other");
  assert.equal(by.theirs.github.release, null);

  // outside github, or no longer resolvable: kept, without metadata
  assert.equal(by.far.github, null);
  assert.equal(by.gone.github, null);
  assert.equal(by.far.official, false);
});

const DATA = merge(LISTING, {
  hedge: repo("briar-systems", "hedge", { stargazerCount: 5, pushedAt: "2026-09-10T00:00:00Z" }),
  theirs: repo("someone", "theirs", { stargazerCount: 50, pushedAt: "2026-09-22T00:00:00Z", latestRelease: null }),
}, "2026-09-23T00:00:00Z");

const ids = (entries) => entries.map((e) => e.id);
const state = (patch) => Object.assign(page.readState(""), patch);

test("readState falls back to defaults and rejects unknown values", () => {
  assert.deepEqual(page.readState(""), { q: "", category: "all", source: "all", sort: "stars" });
  assert.deepEqual(page.readState("?q=tls&sort=bogus&source=x&category=net"), { q: "tls", category: "net", source: "all", sort: "stars" });
});

test("writeState omits defaults and round-trips", () => {
  assert.equal(page.writeState(page.readState("")), "");
  const s = state({ q: "web server", sort: "name" });
  assert.deepEqual(page.readState(page.writeState(s)), s);
});

test("search needs every term, across name, description, repo, and category title", () => {
  assert.deepEqual(ids(page.select(DATA, state({ q: "server" }))), ["hedge"]);
  assert.deepEqual(ids(page.select(DATA, state({ q: "NETWORKING community" }))), ["theirs"]);
  assert.deepEqual(ids(page.select(DATA, state({ q: "briar-systems/hedge" }))), ["hedge"]);
  assert.deepEqual(ids(page.select(DATA, state({ q: "codeberg" }))), ["far"]);
  assert.deepEqual(ids(page.select(DATA, state({ q: "web nothing" }))), []);
});

test("category and source filter", () => {
  assert.deepEqual(ids(page.select(DATA, state({ category: "web" }))), ["hedge"]);
  assert.deepEqual(ids(page.select(DATA, state({ source: "official" }))), ["hedge"]);
  assert.deepEqual(ids(page.select(DATA, state({ source: "community", sort: "name" }))), ["far", "gone", "theirs"]);
});

test("searched ignores the category so chips can count", () => {
  assert.equal(page.searched(DATA, state({ category: "web" })).length, 4);
});

test("metric sorts put entries without metadata last, by name", () => {
  assert.deepEqual(ids(page.select(DATA, state({ sort: "stars" }))), ["theirs", "hedge", "far", "gone"]);
  assert.deepEqual(ids(page.select(DATA, state({ sort: "updated" }))), ["theirs", "hedge", "far", "gone"]);
  assert.deepEqual(ids(page.select(DATA, state({ sort: "release" }))), ["hedge", "far", "gone", "theirs"]);
  assert.deepEqual(ids(page.select(DATA, state({ sort: "name" }))), ["far", "gone", "hedge", "theirs"]);
});

test("hasSources only once official and community mix", () => {
  assert.equal(page.hasSources(DATA), true);
  assert.equal(page.hasSources({ entries: DATA.entries.filter((e) => e.official) }), false);
  assert.equal(page.hasSources({ entries: DATA.entries.filter((e) => !e.official) }), false);
});

test("relative and compact", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  assert.equal(page.relative("2026-09-23T01:00:00Z", now), "today");
  assert.equal(page.relative("2026-09-22T01:00:00Z", now), "yesterday");
  assert.equal(page.relative("2026-09-13T12:00:00Z", now), "10 days ago");
  assert.equal(page.relative("2026-08-01T12:00:00Z", now), "a month ago");
  assert.equal(page.relative("2026-03-01T12:00:00Z", now), "6 months ago");
  assert.equal(page.relative("2024-09-01T12:00:00Z", now), "2 years ago");
  assert.equal(page.relative("nope", now), "");
  assert.equal(page.compact(999), "999");
  assert.equal(page.compact(1000), "1k");
  assert.equal(page.compact(1540), "1.5k");
  assert.equal(page.compact(23400), "23k");
});
