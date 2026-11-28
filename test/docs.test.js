// run with: node --test test/docs.test.js
// the docs generator and the fetch that feeds it: the markdown a page of mach's
// guide may hold, what is refused, how each release's guide is chosen and laid
// out, and the pages built from the two releases under test/guide.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const docs = require("../.github/scripts/build-docs.js");
const guide = require("../.github/scripts/fetch-guide.js");

const GUIDES = path.join(__dirname, "guide");

function page(body) {
  return docs.render("# Title\n\nThe lead.\n\n" + body, "test.md");
}

test("a page is its title, its lead and its body", () => {
  const p = page("## First part\n\nOne\ntwo.\n\n### A `code` heading\n\n#### Deep");
  assert.equal(p.title, "Title");
  assert.equal(p.lead, "The lead.");
  assert.equal(p.html, '<h2 id="first-part">First part</h2>\n\n<p>One two.</p>\n\n<h3 id="a-code-heading">A <code>code</code> heading</h3>\n\n<h4 id="deep">Deep</h4>');
  // the contents list holds the first two levels under the title
  assert.deepEqual(p.headings, [{ id: "first-part", text: "First part", level: 2 }, { id: "a-code-heading", text: "A code heading", level: 3 }]);
  assert.ok(p.ids.has("deep"));
});

test("code blocks are highlighted by their language and escaped", () => {
  assert.equal(page("```mach\nret a < b;\n```").html, '<pre class="code"><code><span class="kw">ret</span> a &lt; b;</code></pre>');
  assert.match(page('```toml\nid = "x"\n```').html, /toml-key/);
  assert.equal(page("```sh\nmach build . > log\n```").html, '<pre class="code"><code>mach build . &gt; log</code></pre>');
  assert.equal(page("```text\n## not a heading\n```").headings.length, 0);
});

test("inline markup and links between pages", () => {
  const p = page("See [the `i64` type](types.md#integers), [here](#x), [out](https://example.org/a_b) and **bold** *soft* `a*b*c`.\n\n## X");
  // a file of the mach repository opens at the ref the pages are built for, and this site's own pages stay on it
  const q = docs.render("# T\n\nLead.\n\n[ref](../language/types.md#casts) [dist](../../dist) [play](https://machlang.org/playground/)", "t.md", "v7.3.0");
  assert.equal(q.html, '<p><a href="https://github.com/briar-systems/mach/blob/v7.3.0/doc/language/types.md#casts" target="_blank" rel="noopener">ref</a> <a href="https://github.com/briar-systems/mach/blob/v7.3.0/dist" target="_blank" rel="noopener">dist</a> <a href="/playground/">play</a></p>');
  assert.equal(
    p.html.split("\n\n")[0],
    '<p>See <a href="types.html#integers">the <code>i64</code> type</a>, <a href="#x">here</a>, <a href="https://example.org/a_b" target="_blank" rel="noopener">out</a> and <strong>bold</strong> <em>soft</em> <code>a*b*c</code>.</p>',
  );
});

test("lists, tables and callouts", () => {
  assert.equal(page("- one\n  more\n- two\n  - inner\n- three").html, "<ul><li>one more</li><li>two<ul><li>inner</li></ul></li><li>three</li></ul>");
  assert.equal(page("1. first\n2. second").html, "<ol><li>first</li><li>second</li></ol>");
  assert.equal(
    page("| a | b |\n|---|---|\n| `x\\|y` | 2 |").html,
    '<div class="table-wrap"><table>\n<thead><tr><th>a</th><th>b</th></tr></thead>\n<tbody>\n<tr><td><code>x|y</code></td><td>2</td></tr>\n</tbody>\n</table></div>',
  );
  assert.equal(page("> **Note:** Careful with `x`.").html, '<div class="callout note"><span class="callout-label">Note</span><p>Careful with <code>x</code>.</p></div>');
});

test("a malformed page is refused, naming what is wrong", () => {
  assert.throws(() => docs.render("No title.", "x.md"), /opens with its # title/);
  assert.throws(() => docs.render("# Title\n\n## Part", "x.md"), /lead paragraph/);
  assert.throws(() => page("## Same\n\n## Same"), /two headings/);
  assert.throws(() => page("```mach\nret 1;"), /never closed/);
  assert.throws(() => page("> a plain quote"), /label in bold/);
  assert.throws(() => page("| a |\n| b |"), /header row/);
  assert.throws(() => page("```mach partial\nret 1;\n```"), /fragment/);
  assert.throws(() => page("```mach fragment extra\nret 1;\n```"), /fragment/);
  assert.throws(() => page("```mach error\nret 1;\n```"), /error <text>/);
  assert.throws(() => page("[x](/playground/)"), /a link is/);
});

test("a mach block may say it is a fragment or what refuses it", () => {
  const p = page("```mach\nval A: i64 = 1;\n```\n\n```mach fragment\nret A;\n```\n\n```mach error no such name\nval B: i64 = C;\n```");
  assert.equal(p.html.match(/<pre class="code"><code><span class="kw">/g).length, 3);
});

function built(fn) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mach-docs-"));
  try {
    return fn(out, docs.build(GUIDES, out));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test("every release is built under its minor, and the newest at the root too", () => {
  built((out, loaded) => {
    assert.deepEqual(loaded.map((g) => g.version), ["7.4.1", "7.3.0"]);
    const read = (file) => fs.readFileSync(path.join(out, file), "utf8");
    assert.deepEqual(fs.readdirSync(out).sort(), ["7.3", "7.4", "functions.html", "index.html", "packs.html", "search.js", "types.html", "versions.json"]);
    assert.deepEqual(fs.readdirSync(path.join(out, "7.3")).sort(), ["index.html", "packs.html", "search.js", "types.html"]);
    // the root and the newest release's own directory hold the same pages, each reaching the site from where it sits
    assert.match(read("types.html"), /<link rel="stylesheet" href="docs\.css">/);
    assert.match(read("types.html"), /src="\.\.\/assets\/mach\.svg"/);
    assert.match(read("7.4/types.html"), /<link rel="stylesheet" href="\.\.\/docs\.css">/);
    assert.match(read("7.4/types.html"), /src="\.\.\/\.\.\/assets\/mach\.svg"/);
    assert.equal(read("7.4/types.html").replace(/\.\.\/\.\.\//g, "../").replace(/"\.\.\/(docs\.(css|js)|7\.\d\/|[a-z]+\.html)/g, '"$1'), read("types.html").replace(/"\.\.\/(docs\.(css|js)|7\.\d\/|[a-z]+\.html)/g, '"$1'));
    // one shell: the page is marked in the sidebar, which lists that release's pages
    assert.match(read("7.3/packs.html"), /class="nav-link active" href="packs\.html"/);
    assert.equal(read("7.3/packs.html").match(/class="nav-link/g).length, 3);
    assert.match(read("7.3/search.js"), /^\/\/ generated[^\n]*\nwindow\.machDocs = \[\{"title":"Overview"/);
    assert.match(read("7.3/search.js"), /"sections":\[\{"title":"Unrolling","id":"unrolling"\}\]/);
  });
});

test("a page offers itself in every release, and says when it is not the newest", () => {
  built((out) => {
    const read = (file) => fs.readFileSync(path.join(out, file), "utf8");
    // the releases built, newest first, which the server compares mach's newest with
    assert.equal(read("versions.json"), '["7.4.1","7.3.0"]\n');
    const menu = (html) => Array.from(html.matchAll(/<a href="([^"]+)"( aria-current="true")?>v([\d.]+)( <span>latest<\/span>)?<\/a>/g), (m) => [m[3], m[1], Boolean(m[2]), Boolean(m[4])]);
    assert.deepEqual(menu(read("types.html")), [["7.4.1", "types.html", true, true], ["7.3.0", "7.3/types.html", false, false]]);
    assert.deepEqual(menu(read("7.3/types.html")), [["7.4.1", "../types.html", false, true], ["7.3.0", "../7.3/types.html", true, false]]);
    // a page the other release lacks leads to that release's first page
    assert.deepEqual(menu(read("functions.html"))[1], ["7.3.0", "7.3/index.html", false, false]);
    assert.deepEqual(menu(read("7.3/packs.html"))[0], ["7.4.1", "../index.html", false, true]);
    assert.match(read("7.3/types.html"), /class="callout version-note"><p>This is the guide for Mach 7\.3\.0\. <a href="\.\.\/types\.html">The latest is 7\.4\.1\.<\/a>/);
    assert.doesNotMatch(read("types.html") + read("7.4/types.html"), /version-note"/);
    // the newest release's address stands for the page wherever that release has it
    assert.match(read("7.3/types.html"), /<link rel="canonical" href="https:\/\/machlang\.org\/docs\/types\.html">/);
    assert.match(read("7.4/functions.html"), /<link rel="canonical" href="https:\/\/machlang\.org\/docs\/functions\.html">/);
    assert.doesNotMatch(read("7.3/packs.html"), /rel="canonical"/);
  });
});

test("a release's links into the repository open at its tag, and a retired address still answers", () => {
  built((out) => {
    const read = (file) => fs.readFileSync(path.join(out, file), "utf8");
    assert.match(read("types.html"), /href="https:\/\/github\.com\/briar-systems\/mach\/blob\/v7\.4\.1\/doc\/language\/types\.md#integers"/);
    assert.match(read("7.3/types.html"), /blob\/v7\.3\.0\/doc\/language\/types\.md#integers/);
    assert.match(read("index.html"), /<a href="\/playground\/">playground<\/a>/);
    assert.match(read("packs.html"), /url=functions\.html#packs/);
    assert.match(read("7.4/packs.html"), /url=functions\.html#packs/);
    assert.match(read("7.3/packs.html"), /<h1>Packs<\/h1>/);
  });
  // a guide read from a branch before its release opens them at that branch
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mach-docs-"));
  try {
    docs.build(GUIDES, out, { "7.4.1": "dev" });
    assert.match(fs.readFileSync(path.join(out, "types.html"), "utf8"), /blob\/dev\/doc\/language\/types\.md/);
    assert.match(fs.readFileSync(path.join(out, "7.3", "types.html"), "utf8"), /blob\/v7\.3\.0\//);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("a guides directory is refused when it holds nothing, two patches of a minor or a broken link", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mach-guides-"));
  try {
    assert.throws(() => docs.build(dir, path.join(dir, "out")), /holds no guide/);
    fs.cpSync(path.join(GUIDES, "7.3.0"), path.join(dir, "7.3.0"), { recursive: true });
    fs.cpSync(path.join(GUIDES, "7.3.0"), path.join(dir, "7.3.1"), { recursive: true });
    assert.throws(() => docs.build(dir, path.join(dir, "out")), /two releases of 7\.3/);
    fs.rmSync(path.join(dir, "7.3.1"), { recursive: true });
    fs.appendFileSync(path.join(dir, "7.3.0", "types.md"), "\nSee [gone](gone.md).\n");
    assert.throws(() => docs.build(dir, path.join(dir, "out")), /types\.md links to gone\.md, which is no page/);
    fs.writeFileSync(path.join(dir, "7.3.0", "types.md"), "# Types\n\nLead.\n\nSee [packs](packs.md#nowhere).\n");
    assert.throws(() => docs.build(dir, path.join(dir, "out")), /packs#nowhere, which is no heading there/);
    fs.writeFileSync(path.join(dir, "7.3.0", "types.md"), "# Types\n\nLead.\n");
    fs.writeFileSync(path.join(dir, "7.3.0", "stray.md"), "# Stray\n\nLead.\n");
    assert.throws(() => docs.build(dir, path.join(dir, "out")), /stray\.md is in no group of nav\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// a ref advertisement as git's smart http answers it, cut down
const REFS = [
  "001e# service=git-upload-pack\n0000",
  "0155aaaa HEAD\0multi_ack symref=HEAD:refs/heads/dev\n",
  "003caaaa refs/heads/dev\n",
  "003faaaa refs/tags/v7.2.0\n",
  "003faaaa refs/tags/v7.3.0\n",
  "0042bbbb refs/tags/v7.3.0^{}\n",
  "003faaaa refs/tags/v7.3.2\n",
  "003faaaa refs/tags/v7.10.0\n",
  "003faaaa refs/tags/v7.4.1\n",
  "0043aaaa refs/tags/v7.5.0-rc.1\n",
  "0040aaaa refs/tags/v8.0.0.1\n",
  "0040aaaa refs/tags/std-v9.0.0\n",
  "0000",
].join("");

test("the releases documented are each minor's newest patch, from the first with a guide", () => {
  assert.deepEqual(guide.pick(REFS), ["7.10.0", "7.4.1", "7.3.2"]);
  assert.deepEqual(guide.pick("003faaaa refs/tags/v7.2.9\n"), []);
});

// answers the urls a fetch asks for from a table, and records them
function server(files) {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    const body = files[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body };
  };
  return { get, asked };
}

const RAW = "https://raw.githubusercontent.com/briar-systems/mach";
const NAV = JSON.stringify({ groups: [{ group: "Start", pages: ["index", "types"] }] });

test("a fetch lays out each release's nav and pages, and leaves what was there when it fails", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mach-fetch-"));
  const dir = path.join(out, "guide");
  const refs = path.join(out, "refs");
  fs.writeFileSync(refs, REFS.replace(/refs\/tags\/v7\.(10\.0|4\.1)\n/g, "refs/heads/x\n"));
  const log = console.log;
  console.log = () => {};
  try {
    const files = {
      [`${RAW}/v7.3.2/doc/guide/nav.json`]: NAV,
      [`${RAW}/v7.3.2/doc/guide/index.md`]: "# Overview\n\nLead.\n",
      [`${RAW}/v7.3.2/doc/guide/types.md`]: "# Types\n\nLead.\n",
    };
    const tagged = server(files);
    await guide.main([dir, "--refs", refs], tagged.get);
    assert.deepEqual(fs.readdirSync(dir), ["7.3.2"]);
    assert.deepEqual(fs.readdirSync(path.join(dir, "7.3.2")).sort(), ["index.md", "nav.json", "types.md"]);
    assert.equal(tagged.asked.length, 3);
    // a branch named for a release is read in place of the tags, and remembered for its links
    const branch = server({
      [`${RAW}/feat/1/doc/guide/nav.json`]: NAV,
      [`${RAW}/feat/1/doc/guide/index.md`]: "# Overview\n\nLead.\n",
      [`${RAW}/feat/1/doc/guide/types.md`]: "# Types\n\nLead.\n",
    });
    await guide.main([dir, "feat/1=7.4.0"], branch.get);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["7.4.0", "refs.json"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "refs.json"), "utf8")), { "7.4.0": "feat/1" });
    assert.deepEqual(docs.build(dir, path.join(out, "site"), JSON.parse(fs.readFileSync(path.join(dir, "refs.json"), "utf8"))).map((g) => g.version), ["7.4.0"]);
    // a page the nav names and the tag lacks fails the fetch
    delete files[`${RAW}/v7.3.2/doc/guide/types.md`];
    await assert.rejects(guide.main([dir, "--refs", refs], server(files).get), /types\.md answered 404/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["7.4.0", "refs.json"]);
    fs.writeFileSync(refs, "003faaaa refs/tags/v7.2.0\n");
    await assert.rejects(guide.main([dir, "--refs", refs], server(files).get), /no mach release holds a guide: the first is 7\.3\.0/);
  } finally {
    console.log = log;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("a fetch the network drops is made again, and one that says the file is missing is not", async () => {
  const files = {
    [`${RAW}/v7.3.0/doc/guide/nav.json`]: NAV,
    [`${RAW}/v7.3.0/doc/guide/index.md`]: "# Overview\n\nLead.\n",
    [`${RAW}/v7.3.0/doc/guide/types.md`]: "# Types\n\nLead.\n",
  };
  // the nav is dropped twice and the first page is refused once before each is answered
  const failures = { [`${RAW}/v7.3.0/doc/guide/nav.json`]: ["drop", "drop"], [`${RAW}/v7.3.0/doc/guide/index.md`]: [503] };
  const waits = [];
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    const next = (failures[url] || []).shift();
    if (next === "drop") { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }
    if (next) { return { ok: false, status: next, text: async () => "" }; }
    return { ok: files[url] !== undefined, status: files[url] === undefined ? 404 : 200, text: async () => files[url] };
  };
  const wait = async (ms) => { waits.push(ms); };
  const fetched = await guide.fetchGuide(get, "v7.3.0", wait);
  assert.deepEqual(fetched.pages.map((p) => p.name), ["index", "types"]);
  assert.equal(asked.length, 6);
  assert.deepEqual(waits, [250, 500, 250]);
  // a file the tag lacks is asked for once
  delete files[`${RAW}/v7.3.0/doc/guide/types.md`];
  asked.length = 0;
  await assert.rejects(guide.fetchGuide(get, "v7.3.0", wait), /types\.md answered 404/);
  assert.equal(asked.filter((url) => url.endsWith("types.md")).length, 1);
  // a network that stays down fails after the last try, naming why
  const down = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
  waits.length = 0;
  await assert.rejects(guide.fetchGuide(down, "v7.3.0", wait), /nav\.json could not be fetched: ENOTFOUND/);
  assert.deepEqual(waits, [250, 500, 1000]);
});
