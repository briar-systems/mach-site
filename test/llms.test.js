// run with: node --test test/llms.test.js
// it checks the build of the site's half of the llms files. against a running
// server image whose llms settings point at test/stub/github.js, started before
// the server, it also checks the files the server completes from mach's
// doc/language, as the stub serves it from test/stub/language/:
//   SITE_URL=http://127.0.0.1:8080 node --test test/llms.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const llms = require("../.github/scripts/build-llms.js");
const { links, checkLocal } = require("../.github/scripts/check-links.js");

const ROOT = path.resolve(__dirname, "..", "public");
const BASE = "https://machlang.org/docs/page.html";
const SITE_URL = process.env.SITE_URL;
const SERVER = { skip: SITE_URL ? false : "set SITE_URL to check a running server" };
// the newest release test/stub/github.js answers
const RELEASE = "6.10.0";

const docs = require("../.github/scripts/build-docs.js");
// the two releases the tests build from, and the guide a server under test was
// built with: what fetch-guide.js laid out before its image was built
const GUIDES = path.join(__dirname, "guide");
const SERVED = path.resolve(process.env.GUIDES || path.join(__dirname, "..", "out", "guide"));

function md(source) {
  return llms.nested(source, BASE, 2);
}

test("headings nest under the guide's, and code is left alone", () => {
  assert.equal(md("# Title\n\nLead.\n\n## Part\n\n```sh\n# not a heading\n```"), "### Title\n\nLead.\n\n#### Part\n\n```sh\n# not a heading\n```");
});

test("links resolve against the site, and code spans keep theirs", () => {
  assert.equal(
    md("See [the `i64` type](types.md#ints), [here](#x), [play](https://machlang.org/playground/), [the rules](../language/types.md#casts), [out](https://example.org) and `[not](a.md)`."),
    "See [the `i64` type](https://machlang.org/docs/types.html#ints), [here](https://machlang.org/docs/page.html#x), [play](https://machlang.org/playground/), [the rules](https://github.com/briar-systems/mach/blob/v@MACH_VERSION@/doc/language/types.md#casts), [out](https://example.org) and `[not](a.md)`.",
  );
});

test("every page of the newest release's guide is carried, in sidebar order", () => {
  const pages = llms.sitePages(GUIDES, 2);
  const nav = JSON.parse(fs.readFileSync(path.join(GUIDES, "7.4.1", "nav.json"), "utf8"));
  assert.deepEqual(pages.map((p) => p.file), nav.groups.flatMap((g) => g.pages).map((name) => name + ".html"));
  for (const p of pages) {
    assert.match(p.url, /^https:\/\/machlang\.org\/docs\/[a-z-]+\.html$/);
    assert.match(p.markdown, /^### /, p.file);
    assert.doesNotMatch(p.lead, /`|\]\(/, p.file);
  }
});

test("llms.txt carries the facts and the llmstxt.org shape", () => {
  const txt = llms.llmsTxt("9.8.7", [{ title: "Types", url: "https://machlang.org/docs/types.html", lead: "The types." }]);
  const lines = txt.split("\n");
  assert.equal(lines[0], "# Mach");
  assert.match(lines[2], /^> .*no type inference/);
  for (const fact of ["Mach 9.8.7", "releases/tag/v9.8.7", "github.com/briar-systems/mach", "octalide/mach", "install.sh | sh", "install.ps1 | iex", "riscv64", "riscv32", "WebAssembly", "SPIR-V"]) {
    assert.ok(txt.includes(fact), fact);
  }
  assert.ok(txt.includes("- [Types](https://machlang.org/docs/types.html): The types."));
  for (const h of ["## Docs", "## Standard library", "## Ecosystem", "## Editor support", "## Community"]) { assert.ok(lines.includes(h), h); }
});

test("llms-full.txt opens with the rules, then the guide, and ends at the reference", () => {
  const full = llms.llmsFullTxt("9.8.7", [{ url: "https://machlang.org/docs/x.html", markdown: "### X" }]);
  const at = (s) => full.indexOf(s);
  assert.ok(at("## Rules models most often get wrong") > 0);
  assert.ok(at("## Rules") < at("## Guide") && at("## Guide") < at("### X") && at("### X") < at("## Language reference"));
  for (const rule of ["No type inference", "`or`, not `else`", "`for` is the only loop", "`cnt`", "`?x` and `@p`", "No methods", "`sel` and guards", "Explicit generic instantiation", "`use std.runtime;`"]) {
    assert.ok(at(rule) > 0 && at(rule) < at("## Guide"), rule);
  }
  assert.ok(full.endsWith("### X\n\n## Language reference\n"));
});

test("the build writes both templates, with the release left to the server", () => {
  fs.mkdirSync(path.join(__dirname, "..", "out"), { recursive: true });
  const out = fs.mkdtempSync(path.join(__dirname, "..", "out", "llms-"));
  execFileSync(process.execPath, [path.join(__dirname, "..", ".github", "scripts", "build-llms.js"), out, GUIDES]);
  const short = fs.readFileSync(path.join(out, "llms.txt.in"), "utf8");
  const full = fs.readFileSync(path.join(out, "llms-full.txt.in"), "utf8");
  fs.rmSync(out, { recursive: true });
  const pages = llms.sitePages(GUIDES, 2);
  assert.equal(short, llms.llmsTxt(llms.VERSION, pages));
  assert.equal(full, llms.llmsFullTxt(llms.VERSION, pages));
  assert.ok(short.includes(`Mach ${llms.VERSION} (https://github.com/briar-systems/mach/releases/tag/v${llms.VERSION})`));
  assert.ok(full.startsWith(`# Mach ${llms.VERSION}: complete reference`));
  // a link into the repository opens at the release the server fills in
  assert.ok(full.includes(`https://github.com/briar-systems/mach/blob/v${llms.VERSION}/doc/language/types.md#integers`));
});

test("links finds link targets and bare urls, never code", () => {
  const src = "[a](https://a.org/x) see https://b.org/y. `https://c.org` `[d](https://d.org)`\n```\nhttps://e.org\n```";
  assert.deepEqual(links(src), ["https://a.org/x", "https://b.org/y"]);
});

test("machlang.org links resolve against the checkout and the server's routes", () => {
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/llms-full.txt")), null);
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/ecosystem/")), null);
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/install.sh")), null);
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/ecosystem.json")), null);
  assert.match(checkLocal(ROOT, new URL("https://machlang.org/ecosystem/nope")), /no file/);
});

test("a link to a docs page resolves against the pages as they are built", () => {
  // a checkout in miniature: the routes beside public/, and the docs built into it
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "mach-site-"));
  try {
    fs.copyFileSync(path.join(ROOT, "..", "hedge.toml"), path.join(site, "hedge.toml"));
    const root = path.join(site, "public");
    docs.build(GUIDES, path.join(root, "docs"));
    assert.equal(checkLocal(root, new URL("https://machlang.org/docs/types.html")), null);
    assert.equal(checkLocal(root, new URL("https://machlang.org/docs/types.html#casts")), null);
    assert.equal(checkLocal(root, new URL("https://machlang.org/docs/7.3/packs.html#unrolling")), null);
    assert.match(checkLocal(root, new URL("https://machlang.org/docs/nope.html")), /no file/);
    assert.match(checkLocal(root, new URL("https://machlang.org/docs/types.html#no-such-anchor")), /no id/);
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});

// the server's answer, polling for up to 10 seconds while it has none yet
function get(urlPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(urlPath, SITE_URL), { method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function ready(urlPath) {
  const until = Date.now() + 10000;
  for (;;) {
    const res = await get(urlPath);
    if (res.status !== 503) { return res; }
    if (Date.now() > until) { throw new Error(`${urlPath} was not served within 10 seconds`); }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const BLOB = `https://github.com/briar-systems/mach/blob/v${RELEASE}/doc/language`;

// what the server appends for test/stub/language/: README.md, then the files
// it links in its order, then the rest by name, with links made absolute and
// headings demoted outside fences and code spans
const REFERENCE = `
Source: ${BLOB}/README.md

### Language reference

The files below, in the order they are read.

- [Types](${BLOB}/types.md)
- [Functions](${BLOB}/fun.md#calls)
- [Types again](${BLOB}/types.md)
- [Elsewhere](https://example.org/notes.md)

Source: ${BLOB}/types.md

### Types

See [functions](${BLOB}/fun.md#calls), [integers](${BLOB}/types.md#integers), [the tests](https://github.com/briar-systems/mach/blob/v${RELEASE}/test/README.md) and [the site](https://machlang.org/docs/).

\`[not a link](a.md)\` stays as written.

\`\`\`mach
# a comment, not a heading
[x](y.md)
\`\`\`

#### Integers

####### seven hashes stay

Source: ${BLOB}/fun.md

### Functions

#### Calls

~~~~
# fenced with tildes
~~~
still fenced
~~~~
##### Returns

Source: ${BLOB}/alpha.md

### Alpha

Source: ${BLOB}/zeta.md

### Zeta
`;

test("llms.txt is the site's template for the newest release", SERVER, async () => {
  const res = await ready("/llms.txt");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(res.headers["cache-control"], "public, max-age=300");
  assert.equal(res.body, llms.llmsTxt(RELEASE, llms.sitePages(SERVED, 2)));
});

test("llms-full.txt is the site's half, then mach's doc/language at that release", SERVER, async () => {
  const res = await ready("/llms-full.txt");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(res.headers["cache-control"], "public, max-age=300");
  // the template carries the release as a token wherever it goes, a page's link
  // into mach's repository included, and the server puts the release at each
  assert.equal(res.body, llms.llmsFullTxt(llms.VERSION, llms.sitePages(SERVED, 2)).replaceAll(llms.VERSION, RELEASE) + REFERENCE);
});

test("a HEAD answers as its GET, without the body", SERVER, async () => {
  for (const p of ["/llms.txt", "/llms-full.txt"]) {
    const full = await ready(p);
    const head = await get(p, "HEAD");
    assert.equal(head.status, 200, p);
    assert.equal(head.body, "", p);
    assert.equal(head.headers["content-type"], "text/plain; charset=utf-8", p);
    assert.equal(head.headers["content-length"], String(Buffer.byteLength(full.body)), p);
  }
});

test("the health check reports the release the llms files are for", SERVER, async () => {
  await ready("/llms.txt");
  const res = await get("/healthz");
  assert.match(res.body, new RegExp(`\\nllms_version ${RELEASE.replace(/\./g, "\\.")}\\nllms_age_seconds \\d+\\n$`));
});
