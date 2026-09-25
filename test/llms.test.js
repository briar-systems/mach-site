// run with: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const llms = require("../.github/scripts/build-llms.js");
const { links, checkLocal } = require("../.github/scripts/check-links.js");

const ROOT = path.resolve(__dirname, "..");
const BASE = "https://machlang.org/docs/page.html";

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

test("indexOrder follows the index, first mention wins", () => {
  assert.deepEqual(llms.indexOrder("- [a](a.md)\n- [b](b.md#x)\n- [a again](a.md)\n- [ext](https://x.org/c.md)"), ["a.md", "b.md"]);
});

test("absolutize rewrites prose links only", () => {
  const src = "[f](files.md#x) and [here](#y) and [t](../../test/README.md)\n`identity[i64](42)`\n```mach\n[a](b)\n```";
  const out = llms.absolutize(src, "fun.md", "v1.2.3");
  const blob = "https://github.com/briar-systems/mach/blob/v1.2.3/";
  assert.ok(out.includes(`[f](${blob}doc/language/files.md#x)`));
  assert.ok(out.includes(`[here](${blob}doc/language/fun.md#y)`));
  assert.ok(out.includes(`[t](${blob}test/README.md)`));
  assert.ok(out.includes("`identity[i64](42)`"));
  assert.ok(out.includes("```mach\n[a](b)\n```"));
});

test("demote shifts headings outside fences", () => {
  assert.equal(llms.demote("# A\n```mach\n# comment\n```\n## B", 2), "### A\n```mach\n# comment\n```\n#### B");
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

test("llms-full.txt opens with the rules, then the guide and the reference in index order", () => {
  const lang = { "README.md": "# Index\n- [b](b.md)\n- [a](a.md)", "a.md": "# A\n", "b.md": "# B\n", "z.md": "# Z\n" };
  const full = llms.llmsFullTxt("9.8.7", [{ url: "https://machlang.org/docs/x.html", markdown: "### X" }], lang);
  const at = (s) => full.indexOf(s);
  assert.ok(at("## Rules models most often get wrong") > 0);
  assert.ok(at("## Rules") < at("## Guide") && at("## Guide") < at("### X") && at("### X") < at("## Language reference"));
  assert.ok(at("### Index") < at("### B") && at("### B") < at("### A") && at("### A") < at("### Z"));
  for (const rule of ["No type inference", "`or`, not `else`", "`for` is the only loop", "`cnt`", "`?x` and `@p`", "No methods", "`sel` and guards", "Explicit generic instantiation", "`use std.runtime;`"]) {
    assert.ok(at(rule) > 0 && at(rule) < at("## Guide"), rule);
  }
  assert.throws(() => llms.llmsFullTxt("9.8.7", [], { "README.md": "- [gone](gone.md)" }), /gone\.md/);
});

test("the version must be baked", () => {
  const v = require("../assets/version.js").MACH_VERSION;
  if (v === "@MACH_VERSION@") {
    assert.throws(() => llms.bakedVersion(ROOT), /bake-version/);
  } else {
    assert.equal(llms.bakedVersion(ROOT), v);
  }
});

test("links finds link targets and bare urls, never code", () => {
  const src = "[a](https://a.org/x) see https://b.org/y. `https://c.org` `[d](https://d.org)`\n```\nhttps://e.org\n```";
  assert.deepEqual(links(src), ["https://a.org/x", "https://b.org/y"]);
});

test("machlang.org links resolve against the checkout", () => {
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/docs/types.html")), null);
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/ecosystem/")), null);
  assert.equal(checkLocal(ROOT, new URL("https://machlang.org/install.sh")), null);
  assert.match(checkLocal(ROOT, new URL("https://machlang.org/docs/nope.html")), /no file/);
  assert.match(checkLocal(ROOT, new URL("https://machlang.org/docs/types.html#no-such-anchor")), /no id/);
});
