#!/usr/bin/env node
// build llms.txt and llms-full.txt (llmstxt.org) for the current mach release.
// the version comes from the baked assets/version.js, so run bake-version.sh first.
// llms-full.txt is this site's docs/ followed by the mach repo's doc/language/
// at that release tag. needs node 20+. GH_TOKEN, when set, authenticates the
// github api listing of doc/language. MACH_DOCS_DIR reads doc/language from a
// local directory instead of github, for offline runs.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SITE = "https://machlang.org";
const REPO = "briar-systems/mach";
const REPO_URL = `https://github.com/${REPO}`;
const DISCORD = "https://discord.com/invite/dfWG9NhGj7";
const LANG_DIR = "doc/language";
const PLACEHOLDER = "@MACH_VERSION@";

const SUMMARY =
  "Mach is a statically typed, compiled, self-hosted systems language with no hidden control flow, " +
  "no hidden allocation, and no type inference.";

// the baked release version, refusing a raw checkout
function bakedVersion(root) {
  const file = path.join(root, "assets", "version.js");
  delete require.cache[require.resolve(file)];
  const v = require(file).MACH_VERSION;
  if (v === PLACEHOLDER || !/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`${file} carries '${v}', not a baked version: run .github/scripts/bake-version.sh first`);
  }
  return v;
}

// html parsing, scoped to the regular markup of docs/*.html

const VOID = new Set(["br", "img", "meta", "link", "input", "hr", "source", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", middot: "·", rarr: "→", larr: "←", mdash: "—", ndash: "–", hellip: "…" };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
    const v = ENTITIES[e.toLowerCase()];
    if (v === undefined) { throw new Error(`unknown html entity ${m}`); }
    return v;
  });
}

function attrs(src) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(src))) { out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? ""); }
  return out;
}

// a tree of { tag, attrs, children } and string text nodes. mismatched markup throws,
// so a broken page fails the build instead of leaking into llms-full.txt
function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) { continue; }
    if (m[4] !== undefined || m[0] === "<") { top.children.push(decode(m[0])); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      if (top.tag !== tag) { throw new Error(`unbalanced </${tag}> inside <${top.tag}> at offset ${m.index}`); }
      stack.pop();
      continue;
    }
    const node = { tag, attrs: attrs(m[3]), children: [] };
    top.children.push(node);
    if (!VOID.has(tag) && !m[3].trim().endsWith("/")) { stack.push(node); }
  }
  if (stack.length !== 1) { throw new Error(`unclosed <${stack[stack.length - 1].tag}>`); }
  return root;
}

function classes(node) { return (node.attrs.class || "").split(/\s+/).filter(Boolean); }
function hasClass(node, c) { return typeof node !== "string" && classes(node).includes(c); }

function find(node, pred) {
  if (typeof node === "string") { return null; }
  if (pred(node)) { return node; }
  for (const c of node.children) {
    const hit = find(c, pred);
    if (hit) { return hit; }
  }
  return null;
}

function findAll(node, pred, out = []) {
  if (typeof node === "string") { return out; }
  if (pred(node)) { out.push(node); }
  for (const c of node.children) { findAll(c, pred, out); }
  return out;
}

function rawText(node) {
  return typeof node === "string" ? node : node.children.map(rawText).join("");
}

function text(node) { return rawText(node).replace(/\s+/g, " ").trim(); }

// html to markdown. links resolve against base (the page's absolute url)

function inline(nodes, base) {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") { out += n.replace(/\s+/g, " "); continue; }
    switch (n.tag) {
      case "code": out += codeSpan(rawText(n)); break;
      case "strong": case "b": out += wrap("**", inline(n.children, base)); break;
      case "em": case "i": out += wrap("*", inline(n.children, base)); break;
      case "br": out += "\n"; break;
      case "img": break;
      case "a": {
        const label = inline(n.children, base).trim();
        const href = n.attrs.href ? resolve(n.attrs.href, base) : "";
        out += href ? `[${label}](${href})` : label;
        break;
      }
      default: out += inline(n.children, base);
    }
  }
  return out;
}

function wrap(mark, s) {
  const t = s.trim();
  if (!t) { return s; }
  const lead = s.match(/^\s*/)[0];
  const trail = s.match(/\s*$/)[0];
  return `${lead}${mark}${t}${mark}${trail}`;
}

function codeSpan(s) {
  const runs = s.match(/`+/g) || [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

// a site-relative href becomes an absolute machlang.org url, in-page anchors included
function resolve(href, base) {
  return new URL(href, base).href;
}

function fenceLang(pre) {
  if (find(pre, (n) => hasClass(n, "toml-key") || hasClass(n, "toml-head"))) { return "toml"; }
  if (find(pre, (n) => ["kw", "type", "fn", "deco", "mod", "ct"].some((c) => hasClass(n, c)))) { return "mach"; }
  return "";
}

function fenced(body, lang) {
  const runs = body.match(/^`{3,}/gm) || [];
  const fence = "`".repeat(Math.max(2, ...runs.map((r) => r.length)) + 1);
  return `${fence}${lang}\n${body.replace(/\n+$/, "")}\n${fence}`;
}

function table(node, base) {
  const rows = findAll(node, (n) => n.tag === "tr").map((tr) =>
    tr.children
      .filter((c) => typeof c !== "string" && (c.tag === "td" || c.tag === "th"))
      .map((c) => inline(c.children, base).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")),
  );
  if (!rows.length) { return ""; }
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

function list(node, base, depth) {
  const items = node.children.filter((c) => typeof c !== "string" && c.tag === "li");
  return items
    .map((li, i) => {
      const marker = node.tag === "ol" ? `${i + 1}.` : "-";
      const pad = "  ".repeat(depth);
      const nested = li.children.filter((c) => typeof c !== "string" && (c.tag === "ul" || c.tag === "ol"));
      const own = inline(li.children.filter((c) => !nested.includes(c)), base).replace(/\s+/g, " ").trim();
      return [`${pad}${marker} ${own}`, ...nested.map((n) => list(n, base, depth + 1))].join("\n");
    })
    .join("\n");
}

// block-level children to markdown blocks. shift demotes headings so a page nests
// under the section that holds it
function blocks(nodes, base, shift) {
  const out = [];
  let run = [];
  const flush = () => {
    const s = inline(run, base).replace(/[ \t]+/g, " ").trim();
    if (s) { out.push(s); }
    run = [];
  };
  for (const n of nodes) {
    if (typeof n === "string" || !isBlock(n)) { run.push(n); continue; }
    flush();
    const b = block(n, base, shift);
    if (b) { out.push(b); }
  }
  flush();
  return out.join("\n\n");
}

const BLOCK = new Set(["p", "div", "pre", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "nav", "aside", "main", "header", "footer"]);
function isBlock(n) { return BLOCK.has(n.tag) || (n.tag === "a" && hasClass(n, "card")); }

function block(n, base, shift) {
  const h = /^h([1-6])$/.exec(n.tag);
  if (h) { return `${"#".repeat(Math.min(6, Number(h[1]) + shift))} ${inline(n.children, base).trim()}`; }
  switch (n.tag) {
    case "p": return inline(n.children, base).replace(/[ \t]+/g, " ").trim();
    case "pre": return fenced(rawText(n), fenceLang(n));
    case "ul": case "ol": return list(n, base, 0);
    case "table": return table(n, base);
    case "blockquote": return quote(blocks(n.children, base, shift));
  }
  if (hasClass(n, "breadcrumb") || hasClass(n, "page-nav") || hasClass(n, "toc")) { return ""; }
  if (hasClass(n, "cards")) {
    return n.children.filter((c) => typeof c !== "string").map((c) => block(c, base, shift)).filter(Boolean).join("\n");
  }
  if (hasClass(n, "callout")) {
    const label = find(n, (c) => hasClass(c, "callout-label"));
    const rest = n.children.filter((c) => c !== label);
    const body = blocks(rest, base, shift);
    return quote(label ? `**${text(label)}:** ${body}` : body);
  }
  if (n.tag === "a" && hasClass(n, "card")) {
    const title = find(n, (c) => hasClass(c, "card-title"));
    const desc = find(n, (c) => hasClass(c, "card-desc"));
    const href = resolve(n.attrs.href, base);
    return `- [${title ? text(title) : text(n)}](${href})${desc ? `: ${text(desc)}` : ""}`;
  }
  return blocks(n.children, base, shift);
}

function quote(s) { return s.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"); }

// the docs pages in sidebar order, each { file, title, group, url, lead, markdown }
function sitePages(root, shift) {
  const docs = path.join(root, "docs");
  const index = parse(fs.readFileSync(path.join(docs, "index.html"), "utf8"));
  const nav = find(index, (n) => n.tag === "aside" && hasClass(n, "sidebar"));
  if (!nav) { throw new Error("docs/index.html has no sidebar"); }
  const pages = [];
  for (const group of findAll(nav, (n) => hasClass(n, "nav-group"))) {
    const label = find(group, (n) => hasClass(n, "nav-group-label"));
    for (const a of findAll(group, (n) => n.tag === "a" && hasClass(n, "nav-link"))) {
      const file = a.attrs.href;
      const url = `${SITE}/docs/${file}`;
      const doc = parse(fs.readFileSync(path.join(docs, file), "utf8"));
      const main = find(doc, (n) => n.tag === "main");
      if (!main) { throw new Error(`docs/${file} has no <main>`); }
      const lead = find(main, (n) => n.tag === "p" && hasClass(n, "lead"));
      pages.push({
        file,
        title: text(a),
        group: label ? text(label) : "",
        url,
        lead: lead ? text(lead) : "",
        markdown: blocks(main.children, url, shift),
      });
    }
  }
  const listed = new Set(pages.map((p) => p.file));
  const missing = fs.readdirSync(docs).filter((f) => f.endsWith(".html") && !listed.has(f));
  if (missing.length) { throw new Error(`docs pages missing from the sidebar: ${missing.join(", ")}`); }
  return pages;
}

// mach doc/language markdown

// the .md files the index links, in order, first mention wins
function indexOrder(readme) {
  const seen = [];
  for (const m of readme.matchAll(/\]\(([A-Za-z0-9_-]+\.md)(?:#[^)]*)?\)/g)) {
    if (!seen.includes(m[1])) { seen.push(m[1]); }
  }
  return seen;
}

// rewrite relative links in one doc to absolute github urls at the tag, outside fences
function absolutize(md, file, tag) {
  const blob = `${REPO_URL}/blob/${tag}/`;
  const here = `${LANG_DIR}/${file}`;
  return mapText(md, (seg) =>
    seg.replace(/(\]\()([^)\s]+)(\))/g, (m, open, href, close) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { return m; }
      const url = href.startsWith("#") ? blob + here + href : new URL(href, blob + here).href;
      return open + url + close;
    }),
  );
}

// apply fn to every line outside fenced code blocks
function mapProse(md, fn) {
  let fence = null;
  return md
    .split("\n")
    .map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (m) {
        if (!fence) { fence = m[1]; return line; }
        if (m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) { fence = null; return line; }
      }
      return fence ? line : fn(line);
    })
    .join("\n");
}

// apply fn to the prose outside fenced blocks and inline code spans
function mapText(md, fn) {
  return mapProse(md, (line) => {
    let out = "";
    let at = 0;
    const re = /(`+)[\s\S]*?\1/g;
    let m;
    while ((m = re.exec(line))) {
      out += fn(line.slice(at, m.index)) + m[0];
      at = m.index + m[0].length;
    }
    return out + fn(line.slice(at));
  });
}

function demote(md, shift) {
  return mapProse(md, (line) => line.replace(/^(#{1,6})(?=\s)/, (h) => "#".repeat(Math.min(6, h.length + shift))));
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) { throw new Error(`${url}: ${res.status} ${res.statusText}`); }
  return res.text();
}

// { name: markdown } for doc/language at the tag
async function languageDocs(tag) {
  const local = process.env.MACH_DOCS_DIR;
  if (local) {
    const out = {};
    for (const f of fs.readdirSync(local).filter((f) => f.endsWith(".md"))) { out[f] = fs.readFileSync(path.join(local, f), "utf8"); }
    return out;
  }
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) { headers.Authorization = `Bearer ${process.env.GH_TOKEN}`; }
  const listing = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/contents/${LANG_DIR}?ref=${tag}`, headers));
  const names = listing.filter((e) => e.type === "file" && e.name.endsWith(".md")).map((e) => e.name);
  const out = {};
  await Promise.all(names.map(async (n) => {
    out[n] = await fetchText(`https://raw.githubusercontent.com/${REPO}/${tag}/${LANG_DIR}/${n}`);
  }));
  return out;
}

// output

function llmsTxt(version, pages) {
  const tag = `v${version}`;
  const lines = [
    "# Mach",
    "",
    `> ${SUMMARY}`,
    "",
    `The current release is Mach ${version} (${REPO_URL}/releases/tag/${tag}). Every release, with prebuilt binaries for Linux, macOS, and Windows and a SHA256SUMS file, is on ${REPO_URL}/releases. ` +
      `The canonical repository is ${REPO_URL}: the old github.com/octalide/mach moved there, so sources that cite it, the June 2026 Show HN, or early READMEs are out of date. ` +
      `Install the latest release on Linux and macOS with \`curl -fsSL ${SITE}/install.sh | sh\`, and on Windows in PowerShell with \`irm ${SITE}/install.ps1 | iex\`. ` +
      "Mach targets Linux, macOS, Windows, and freestanding (no OS) on x86_64, aarch64, and riscv64, plus SPIR-V for GPU shaders. WebAssembly is not supported yet. " +
      "The compiler, its code generators, and its linker are written in Mach and have no external dependencies.",
    "",
    "## Docs",
    "",
  ];
  for (const p of pages) { lines.push(`- [${p.title}](${p.url})${p.lead ? `: ${p.lead}` : ""}`); }
  lines.push(
    `- [Language reference](${REPO_URL}/tree/${tag}/${LANG_DIR}): the authoritative per-construct reference, with grammar, at the current release`,
    `- [Changelog](${REPO_URL}/blob/${tag}/CHANGELOG.md): every change, release by release`,
    "",
    "## Standard library",
    "",
    "- [mach-std](https://github.com/briar-systems/mach-std): the standard library, a dependency every program declares in `mach.toml`, fetched by `mach init`",
    "",
    "## Ecosystem",
    "",
    `- [Ecosystem](${SITE}/ecosystem/): searchable catalog of libraries, tools, and projects written in and for Mach`,
    "- [mach-ecosystem](https://github.com/briar-systems/mach-ecosystem): the listing behind the catalog, and how to add a project to it",
    "- [awesome-mach](https://github.com/briar-systems/awesome-mach): curated list of Mach resources",
    "",
    "## Editor support",
    "",
    "- [mach-lsp](https://github.com/briar-systems/mach-lsp): language server",
    "- [mach-vscode](https://github.com/briar-systems/mach-vscode): Visual Studio Code extension",
    "- [mach-zed](https://github.com/briar-systems/mach-zed): Zed extension",
    "- [mach-tree-sitter](https://github.com/briar-systems/mach-tree-sitter): tree-sitter grammar",
    "",
    "## Community",
    "",
    `- [Discord](${DISCORD}): questions, announcements, and discussion`,
    `- [Issues](${REPO_URL}/issues): bug reports and feature requests for the compiler`,
    "",
    "## Optional",
    "",
    `- [llms-full.txt](${SITE}/llms-full.txt): the complete language reference as one file, opening with the rules models most often get wrong`,
    "",
  );
  return lines.join("\n");
}

const RULES = `## Rules models most often get wrong

Mach is not C, Rust, Zig, or Go. Code written from those habits does not compile. Hold to these rules:

- **No type inference.** Every binding states its type: \`val n: i64 = 42;\` and \`var i: i64 = 0;\`. There is no \`let\`, no \`:=\`, and no \`auto\`. \`val\` is immutable and \`var\` is mutable.
- **\`or\`, not \`else\`.** A conditional chain is \`if (a) { ... } or (b) { ... } or { ... }\`. There is no \`else\` and no \`else if\`, and bodies always take braces.
- **\`for\` is the only loop.** \`for (cond) { ... }\` loops while the condition holds, and a bare \`for { ... }\` loops until a \`brk\` or \`ret\` leaves it. There is no \`while\`, no \`loop\`, and no for-each or range loop.
- **\`ret\`, \`brk\`, and \`cnt\`.** Return is \`ret expr;\` or \`ret;\`. Loop exit is \`brk;\` and next iteration is \`cnt;\`. There is no \`return\`, \`break\`, or \`continue\`.
- **\`?x\` and \`@p\` for pointers.** \`?x\` takes the address of a place and \`@p\` dereferences a pointer, for reads and writes alike: \`var p: *i64 = ?x; @p = 11;\`. There is no \`&x\` or \`*p\` expression. \`*T\` appears only in types.
- **No methods.** Records hold fields only. There is no \`impl\`, no \`self\`, and no member function. Write a free function that takes the record, or a pointer to it. In \`print.println(...)\`, \`print\` is a module alias, not a receiver.
- **\`sel\` and guards for tagged unions.** \`sel p.case\` tests which case a \`tag\` holds. A payload \`p.case\` may be read only inside a guard: an \`if\` or \`or\` arm whose condition is exactly \`sel p.case\`, or the rest of a block after a chain whose every arm exits. There is no \`match\`, no \`switch\`, and no \`==\` on tags.
- **Explicit generic instantiation.** Type arguments are always written in brackets at the use: \`identity[i64](42)\` and \`Pair[i64, u8]\`. They are never inferred from the arguments.
- **Executables need \`use std.runtime;\` and \`#[symbol("main")]\`.** The runtime supplies \`_start\`, and the entry point is whichever function exports the \`main\` symbol, with the signature \`fun main(argc: i64, argv: **u8) i64\`:

\`\`\`mach
use std.runtime;
use print: std.print;

#[symbol("main")]
fun main(argc: i64, argv: **u8) i64 {
    print.println("Hello, World!");
    ret 0;
}
\`\`\``;

function llmsFullTxt(version, pages, lang) {
  const tag = `v${version}`;
  const order = indexOrder(lang["README.md"] || "");
  const rest = Object.keys(lang).filter((n) => n !== "README.md" && !order.includes(n)).sort();
  const missing = order.filter((n) => !(n in lang));
  if (missing.length) { throw new Error(`${LANG_DIR}/README.md at ${tag} links missing files: ${missing.join(", ")}`); }
  const refs = ["README.md", ...order, ...rest].filter((n) => n in lang);

  const parts = [
    `# Mach ${version}: complete reference`,
    "",
    `> ${SUMMARY}`,
    "",
    `This file is generated at each deploy of ${SITE} from the current release, Mach ${version}: the guide at ${SITE}/docs/, then the language reference in ${REPO_URL}/tree/${tag}/${LANG_DIR}. ` +
      `The canonical repository is ${REPO_URL}. Where the two parts differ, the language reference is authoritative. The short index is ${SITE}/llms.txt.`,
    "",
    RULES,
    "",
    "## Guide",
    "",
  ];
  for (const p of pages) {
    parts.push(`Source: ${p.url}`, "", p.markdown, "");
  }
  parts.push("## Language reference", "");
  for (const n of refs) {
    const src = `${REPO_URL}/blob/${tag}/${LANG_DIR}/${n}`;
    parts.push(`Source: ${src}`, "", demote(absolutize(lang[n].trim(), n, tag), 2), "");
  }
  return parts.join("\n");
}

async function main() {
  const root = path.resolve(__dirname, "..", "..");
  const version = bakedVersion(root);
  const pages = sitePages(root, 2);
  const lang = await languageDocs(`v${version}`);
  fs.writeFileSync(path.join(root, "llms.txt"), llmsTxt(version, pages));
  fs.writeFileSync(path.join(root, "llms-full.txt"), llmsFullTxt(version, pages, lang));
  console.log(`built llms.txt and llms-full.txt for mach ${version}: ${pages.length} guide pages, ${Object.keys(lang).length} reference files`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { parse, blocks, indexOrder, absolutize, demote, mapProse, mapText, bakedVersion, llmsTxt, llmsFullTxt, sitePages };
