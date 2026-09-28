// run with: node --test test/ecosystem.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const page = require("../public/assets/ecosystem.js");

// a catalog document, as the server embeds it in the page
const DATA = {
  generated: "2026-09-23T00:00:00Z",
  source: "https://github.com/briar-systems/mach-ecosystem",
  categories: [
    {
      id: "web",
      title: "Web",
      description: "Servers."
    },
    {
      id: "net",
      title: "Networking",
      description: "Protocols."
    }
  ],
  entries: [
    {
      id: "hedge",
      name: "hedge",
      url: "https://github.com/briar-systems/hedge",
      description: "Web server.",
      category: "web",
      official: true,
      github: {
        repo: "briar-systems/hedge",
        owner: "briar-systems",
        stars: 5,
        forks: 1,
        pushed: "2026-09-10T00:00:00Z",
        license: "MIT",
        release: {
          tag: "v1.0.0",
          published: "2026-09-01T00:00:00Z"
        }
      }
    },
    {
      id: "far",
      name: "far",
      url: "https://codeberg.org/someone/far",
      description: "Hosted elsewhere.",
      category: "net",
      official: false,
      github: null
    },
    {
      id: "gone",
      name: "gone",
      url: "https://github.com/someone/gone",
      description: "Deleted repo.",
      category: "net",
      official: false,
      github: null
    },
    {
      id: "theirs",
      name: "theirs",
      url: "https://github.com/Someone/theirs",
      description: "Community project.",
      category: "net",
      official: false,
      github: {
        repo: "someone/theirs",
        owner: "someone",
        stars: 50,
        forks: 1,
        pushed: "2026-09-22T00:00:00Z",
        license: "MIT",
        release: null
      }
    }
  ]
};

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
