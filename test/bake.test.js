// the pages-only ecosystem bake, removed at the cutover with the script it
// tests. run with: node --test test/bake.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { githubRepo, metadataQuery, merge } = require("../.github/scripts/bake-ecosystem.js");

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
