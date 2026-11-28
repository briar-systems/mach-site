#!/usr/bin/env node
// build the site half of llms.txt and llms-full.txt (llmstxt.org): the templates
// the server completes for each mach release. llms.txt.in is llms.txt whole, and
// llms-full.txt.in is llms-full.txt up to its language reference, which is
// mach's guide as markdown: the newest release's among those fetch-guide.js
// laid out. both carry @MACH_VERSION@ wherever the release goes, and the server
// fills it in and appends mach's doc/language at that release (src/llms/).
//
// usage: build-llms.js [output dir] [guides dir]   (out/llms and out/guide). needs node 20+.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const docs = require("./build-docs.js");

const SITE = "https://machlang.org";
const REPO = "briar-systems/mach";
const REPO_URL = `https://github.com/${REPO}`;
const DISCORD = "https://discord.com/invite/dfWG9NhGj7";
const LANG_DIR = "doc/language";
// what the server replaces with the release, such as 6.7.0
const VERSION = "@MACH_VERSION@";

const SUMMARY =
  "Mach is a statically typed, compiled, self-hosted systems language with no hidden control flow, " +
  "no hidden allocation, and no type inference.";

// the docs pages in sidebar order, each { file, title, group, url, lead, markdown }.
// the pages are markdown already (docs/, which build-docs.js renders for the
// site), so each is carried as it is, its headings nested under the guide's and
// its links made absolute
function sitePages(guides, shift) {
  const pages = [];
  const newest = docs.versions(guides)[0];
  for (const group of docs.load(path.join(guides, newest), "v" + newest).groups) {
    for (const p of group.pages) {
      const url = `${SITE}/docs/${p.slug}.html`;
      pages.push({
        file: `${p.slug}.html`,
        title: p.title,
        group: group.group,
        url,
        lead: plain(p.lead),
        markdown: nested(p.markdown, url, shift),
      });
    }
  }
  return pages;
}

// a lead without its markup, for the one line llms.txt gives a page
function plain(md) {
  return md.replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*/g, "");
}

// a page's markdown as the guide carries it: every heading `shift` levels
// deeper, and every link that is relative to the site made absolute
function nested(md, url, shift) {
  const deeper = mapProse(md.trim(), (line) => line.replace(/^(#{1,6}) /, (_m, marks) => "#".repeat(marks.length + shift) + " "));
  return mapText(deeper, (text) => text.replace(/\]\(([^)\s]+)\)/g, (_m, target) => `](${resolve(target, url)})`));
}

// where a link in a docs page points once the page is read away from the
// site: the guide's own pages on the site, and the repository at the release
function resolve(target, url) {
  const to = docs.link(target, url);
  if (to.kind === "anchor") { return url + to.hash; }
  if (to.kind === "page") { return `${SITE}/docs/${to.page}.html${to.hash}`; }
  if (to.kind === "repo") { return `${REPO_URL}/blob/v${VERSION}/${to.file}${to.hash}`; }
  if (to.kind === "site") { return SITE + to.path + to.hash; }
  return to.url + to.hash;
}

// markdown prose, which check-links.js reads links from

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
      "Mach targets Linux, macOS, Windows, UEFI, and freestanding (no OS) on x86_64, aarch64, riscv64, and riscv32, WebAssembly (WASI Preview 1 on wasm32), plus SPIR-V (Vulkan and OpenCL) for GPU shaders and compute. " +
      "The compiler, its code generators, and its linker are written in Mach and have no external dependencies.",
    "",
    "## Docs",
    "",
  ];
  for (const p of pages) { lines.push(`- [${p.title}](${p.url})${p.lead ? `: ${p.lead}` : ""}`); }
  lines.push(
    `- [Playground](${SITE}/playground/): write Mach in the browser, where the compiler itself builds it for any target, runs programs, draws shaders and lists assembly, SPIR-V and IR`,
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

// llms-full.txt up to and including its language reference heading. the server
// appends each doc/language file after it, README.md first
function llmsFullTxt(version, pages) {
  const tag = `v${version}`;
  const parts = [
    `# Mach ${version}: complete reference`,
    "",
    `> ${SUMMARY}`,
    "",
    `This file is served by ${SITE}, which rebuilds it from each new Mach release. It covers the current release, Mach ${version}: the guide at ${SITE}/docs/, then the language reference in ${REPO_URL}/tree/${tag}/${LANG_DIR}. ` +
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
  return parts.join("\n");
}

function main() {
  const out = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "out", "llms"));
  const guides = path.resolve(process.argv[3] || path.join(__dirname, "..", "..", "out", "guide"));
  const pages = sitePages(guides, 2);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "llms.txt.in"), llmsTxt(VERSION, pages));
  fs.writeFileSync(path.join(out, "llms-full.txt.in"), llmsFullTxt(VERSION, pages));
  console.log(`built the llms templates in ${out}: ${pages.length} guide pages`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { VERSION, nested, mapProse, mapText, llmsTxt, llmsFullTxt, sitePages };
