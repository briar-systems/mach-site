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
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const llms = require("../.github/scripts/build-llms.js");
const { links, checkLocal, served: servedPaths } = require("../.github/scripts/check-links.js");

const ROOT = path.resolve(__dirname, "..", "public");
const BASE = "https://machlang.org/docs/page.html";
const SITE_URL = process.env.SITE_URL;
const SERVER = { skip: SITE_URL ? false : "set SITE_URL to check a running server" };
// the newest release test/stub/github.js answers
const RELEASE = "6.10.0";

function md(html) {
  return llms.blocks(llms.parse(html).children, BASE, 2);
}

test("parse refuses unbalanced markup", () => {
  assert.throws(() => llms.parse("<p><span class=\"ct>^</span></p>"), /unbalanced|unclosed/);
  assert.throws(() => llms.parse("<div><p>x</div>"), /unbalanced/);
});

test("headings demote and prose collapses", () => {
  assert.equal(md("<h1>Title</h1>\n<p>one\n  two</p>"), "### Title\n\none two");
});

test("code blocks keep their text and pick a fence language", () => {
  const out = md('<pre class="code"><code><span class="kw">ret</span> a &lt; b;</code></pre>');
  assert.equal(out, "```mach\nret a < b;\n```");
  assert.equal(md('<pre class="code"><code>mach build .</code></pre>'), "```\nmach build .\n```");
  assert.equal(md('<pre class="code"><code><span class="toml-key">id</span> = "x"</code></pre>'), '```toml\nid = "x"\n```');
});

test("inline markup, links and anchors resolve against the page", () => {
  assert.equal(
    md('<p>See <a href="types.html#ints">the <code>i64</code> type</a> and <a href="#x">here</a>, <strong>bold</strong>.</p>'),
    "See [the `i64` type](https://machlang.org/docs/types.html#ints) and [here](https://machlang.org/docs/page.html#x), **bold**.",
  );
});

test("callouts, tables, and page chrome", () => {
  assert.equal(md('<div class="callout note"><span class="callout-label">Note</span><p>Careful.</p></div>'), "> **Note:** Careful.");
  assert.equal(
    md("<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><code>x|y</code></td><td>2</td></tr></tbody></table>"),
    "| a | b |\n| --- | --- |\n| `x\\|y` | 2 |",
  );
  assert.equal(md('<div class="breadcrumb">Docs</div><div class="page-nav"><a href="x.html">x</a></div><p>kept</p>'), "kept");
});

test("every docs page is in the sidebar and converts", () => {
  const pages = llms.sitePages(ROOT, 2);
  assert.ok(pages.length > 0);
  for (const p of pages) {
    assert.match(p.url, /^https:\/\/machlang\.org\/docs\/[a-z-]+\.html$/);
    assert.match(p.markdown, /^### /m, p.file);
  }
});

test("llms.txt carries the facts and the llmstxt.org shape", () => {
  const txt = llms.llmsTxt("9.8.7", [{ title: "Types", url: "https://machlang.org/docs/types.html", lead: "The types." }]);
  const lines = txt.split("\n");
  assert.equal(lines[0], "# Mach");
  assert.match(lines[2], /^> .*no type inference/);
  for (const fact of ["Mach 9.8.7", "releases/tag/v9.8.7", "github.com/briar-systems/mach", "octalide/mach", "install.sh | sh", "install.ps1 | iex", "riscv64", "SPIR-V", "WebAssembly is not supported"]) {
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
  execFileSync(process.execPath, [path.join(__dirname, "..", ".github", "scripts", "build-llms.js"), out]);
  const short = fs.readFileSync(path.join(out, "llms.txt.in"), "utf8");
  const full = fs.readFileSync(path.join(out, "llms-full.txt.in"), "utf8");
  fs.rmSync(out, { recursive: true });
  const pages = llms.sitePages(ROOT, 2);
  assert.equal(short, llms.llmsTxt(llms.VERSION, pages));
  assert.equal(full, llms.llmsFullTxt(llms.VERSION, pages));
  assert.ok(short.includes(`Mach ${llms.VERSION} (https://github.com/briar-systems/mach/releases/tag/v${llms.VERSION})`));
  assert.ok(full.startsWith(`# Mach ${llms.VERSION}: complete reference`));
});

test("links finds link targets and bare urls, never code", () => {
  const src = "[a](https://a.org/x) see https://b.org/y. `https://c.org` `[d](https://d.org)`\n```\nhttps://e.org\n```";
  assert.deepEqual(links(src), ["https://a.org/x", "https://b.org/y"]);
});

test("machlang.org links resolve against the checkout and the server's routes", () => {
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/docs/types.html")), null);
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/llms-full.txt")), null);
  assert.ok(servedPaths().includes("/llms.txt"));
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/ecosystem/")), null);
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/install.sh")), null);
  assert.match(checkLocal(ROOT, new URL("https://machlang.org/docs/nope.html")), /no file/);
  assert.match(checkLocal(ROOT, new URL("https://machlang.org/docs/types.html#no-such-anchor")), /no id/);
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
  assert.equal(res.body, llms.llmsTxt(RELEASE, llms.sitePages(ROOT, 2)));
});

test("llms-full.txt is the site's half, then mach's doc/language at that release", SERVER, async () => {
  const res = await ready("/llms-full.txt");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(res.headers["cache-control"], "public, max-age=300");
  assert.equal(res.body, llms.llmsFullTxt(RELEASE, llms.sitePages(ROOT, 2)) + REFERENCE);
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
