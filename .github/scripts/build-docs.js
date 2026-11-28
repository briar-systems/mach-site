#!/usr/bin/env node
// builds the docs pages from mach's guide, the markdown under doc/guide in the
// mach repository. each release carries its own, and fetch-guide.js lays them
// out as <guides>/<version>/: nav.json names the groups and the order, and
// <page>.md is one page. every release is built under <out>/<major.minor>/,
// and the newest also at <out>/ itself, each page inside the one shell they
// share and each directory with search.js, the index the search palette reads.
//
// usage: build-docs.js [guides dir] [output dir]
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const SITE = "https://machlang.org";
const REPO = "https://github.com/briar-systems/mach";
// where the guide sits in the mach repository, which its relative links start from
const GUIDE = "doc/guide";
const highlight = require(path.join(ROOT, "public", "assets", "highlight.js"));

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// a heading's anchor: its text in lowercase, words joined by dashes
function slug(text) {
  return text.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9$]+/g, "-").replace(/^-+|-+$/g, "");
}

// what a link in the guide points at. the sources are read on github too, so
// a page of the guide and a file of the repository are relative paths, and a
// page of this site is its full address
function link(target, where) {
  const [, to, hash = ""] = /^([^#]*)(#.*)?$/.exec(target);
  if (to === "") { return { kind: "anchor", hash }; }
  const page = /^([a-z0-9-]+)\.md$/.exec(to);
  if (page) { return { kind: "page", page: page[1], hash }; }
  if (to.startsWith("../")) {
    const file = path.posix.normalize(GUIDE + "/" + to);
    if (file.startsWith("..")) { throw new Error(where + ": " + target + " leaves the repository"); }
    return { kind: "repo", file: file.replace(/\/$/, ""), hash };
  }
  if (to === SITE || to.startsWith(SITE + "/")) { return { kind: "site", path: to.slice(SITE.length) || "/", hash }; }
  if (/^https?:\/\//.test(to)) { return { kind: "web", url: to, hash }; }
  throw new Error(where + ": a link is a page of the guide (types.md), a path in the mach repository (../language/types.md) or a full address, not " + target);
}

// a link as the pages are served
function href(target, where, ref) {
  const to = link(target, where);
  if (to.kind === "anchor") { return to.hash; }
  if (to.kind === "page") { return to.page + ".html" + to.hash; }
  if (to.kind === "repo") { return REPO + "/blob/" + ref + "/" + to.file + to.hash; }
  if (to.kind === "site") { return to.path + to.hash; }
  return to.url + to.hash;
}

// text outside links: code spans as written, then bold and emphasis
function spans(text) {
  let out = "";
  for (const part of text.split(/(`[^`]+`)/)) {
    if (part.length > 1 && part[0] === "`" && part[part.length - 1] === "`") {
      out += "<code>" + esc(part.slice(1, -1)) + "</code>";
      continue;
    }
    out += esc(part)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  }
  return out;
}

// inline markdown: links first, since a link's text may hold a code span and a
// code span may hold a bracket, then everything between them
function inline(text, at) {
  const link = /\[((?:`[^`]*`|[^\]`])+)\]\(([^)\s]+)\)/g;
  // a code span's own brackets never open a link
  const coded = [];
  for (const m of text.matchAll(/`[^`]+`/g)) { coded.push([m.index, m.index + m[0].length]); }
  const inCode = (at) => coded.some(([a, b]) => at > a && at < b);
  let out = "";
  let from = 0;
  for (const m of text.matchAll(link)) {
    if (inCode(m.index)) { continue; }
    const to = href(m[2], at.where, at.ref);
    out += spans(text.slice(from, m.index));
    out += '<a href="' + esc(to) + '"' + (/^https?:/.test(to) ? ' target="_blank" rel="noopener"' : "") + ">" + spans(m[1]) + "</a>";
    from = m.index + m[0].length;
  }
  return out + spans(text.slice(from));
}

function code(lang, text) {
  let body = esc(text);
  if (lang === "mach") { body = highlight.tokenize(text); }
  else if (lang === "toml") { body = highlight.toml(text); }
  return '<pre class="code"><code>' + body + "</code></pre>";
}

function cells(row) {
  return row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

// the markdown the docs are written in: headings, paragraphs, fenced code,
// lists one level deep, pipe tables, and a quote that opens with a bold label
// as a callout. anything else is a mistake in the source and is refused
function render(markdown, where, ref = "main") {
  const at = { where, ref };
  const lines = markdown.replace(/\r/g, "").split("\n");
  const out = [];
  const headings = [];
  const ids = new Set();
  let title = null;
  let lead = null;
  let i = 0;
  const blank = (l) => l.trim() === "";
  const starts = (l) => /^(#{1,4} |```|> |[-*] |\d+\. |\|)/.test(l);

  function list(indent) {
    const ordered = /^\s*\d+\. /.test(lines[i]);
    const marker = ordered ? /^\s*\d+\. / : /^\s*[-*] /;
    const items = [];
    while (i < lines.length && marker.test(lines[i]) && lines[i].search(/\S/) === indent) {
      let text = lines[i].replace(marker, "");
      i++;
      let nested = "";
      while (i < lines.length && !blank(lines[i]) && lines[i].search(/\S/) > indent) {
        if (/^\s*([-*]|\d+\.) /.test(lines[i])) { nested += list(lines[i].search(/\S/)); }
        else { text += " " + lines[i].trim(); i++; }
      }
      items.push("<li>" + inline(text, at) + nested + "</li>");
    }
    return (ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>");
  }

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const h = /^(#{1,4}) (.+)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1) {
        if (title !== null) { throw new Error(where + ": a page has one # heading"); }
        title = text;
      } else {
        const id = slug(text);
        if (ids.has(id)) { throw new Error(where + ": two headings read `" + text + "`"); }
        ids.add(id);
        if (level <= 3) { headings.push({ id, text: text.replace(/`/g, ""), level }); }
        out.push("<h" + level + ' id="' + id + '">' + inline(text, at) + "</h" + level + ">");
      }
      i++;
    } else if (line.startsWith("```")) {
      // the language, and on mach what the guide's readme lets a fence say of
      // the block: `fragment`, or `error <text>` when the compiler refuses it
      const fence = /^(\S*)(?:\s+(\S+)(?:\s+(.+))?)?$/.exec(line.slice(3).trim());
      const [, lang, mark, expect] = fence;
      const marked = mark === undefined || (lang === "mach" && ((mark === "fragment" && !expect) || (mark === "error" && expect)));
      if (!marked) {
        throw new Error(where + ": a code block opens with its language, and a mach block may add `fragment` or `error <text>`: " + line);
      }
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { body.push(lines[i]); i++; }
      if (i === lines.length) { throw new Error(where + ": a code block is never closed"); }
      i++;
      out.push(code(lang, body.join("\n")));
    } else if (line.startsWith("> ")) {
      const quoted = [];
      while (i < lines.length && lines[i].startsWith(">")) { quoted.push(lines[i].replace(/^> ?/, "")); i++; }
      const m = /^\*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(quoted.join(" "));
      if (!m) { throw new Error(where + ": a quote opens with its label in bold, as `> **Note:** ...`"); }
      out.push('<div class="callout note"><span class="callout-label">' + esc(m[1]) + "</span><p>" + inline(m[2], at) + "</p></div>");
    } else if (/^\s*([-*]|\d+\.) /.test(line)) {
      out.push(list(line.search(/\S/)));
    } else if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) { rows.push(lines[i]); i++; }
      if (rows.length < 2 || !/^\|[\s:|-]+\|$/.test(rows[1].trim())) { throw new Error(where + ": a table needs a header row and a rule under it"); }
      const head = cells(rows[0]).map((c) => "<th>" + inline(c, at) + "</th>").join("");
      const body = rows.slice(2).map((r) => "<tr>" + cells(r).map((c) => "<td>" + inline(c, at) + "</td>").join("") + "</tr>").join("\n");
      out.push('<div class="table-wrap"><table>\n<thead><tr>' + head + "</tr></thead>\n<tbody>\n" + body + "\n</tbody>\n</table></div>");
    } else {
      const para = [];
      while (i < lines.length && !blank(lines[i]) && !starts(lines[i])) { para.push(lines[i].trim()); i++; }
      const text = para.join(" ");
      // the paragraph under the title is the page's lead
      if (lead === null && out.length === 0) { lead = text; }
      else { out.push("<p>" + inline(text, at) + "</p>"); }
    }
  }
  if (title === null) { throw new Error(where + ": a page opens with its # title"); }
  if (lead === null) { throw new Error(where + ": a page's title is followed by its lead paragraph"); }
  return { title, lead, leadHtml: inline(lead, at), html: out.join("\n\n"), headings, ids };
}

// a release's place in the menu and in the address: its major and minor
function minor(version) {
  return version.split(".").slice(0, 2).join(".");
}

// newest first
function newer(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
}

// one page. at.docs leads from the page to /docs/ and at.site to the site's
// root, both relative, as the shell's links are from wherever the page sits
function page(at, guide, group, entry, prev, next) {
  const { docs, site, guides, latest } = at;
  const icons = site + "assets/icons.svg";
  const sidebar = guide.groups.map((g) => [
    '        <div class="nav-group">',
    '          <div class="nav-group-label">' + esc(g.group) + "</div>",
    g.pages.map((p) => '          <a class="nav-link' + (p.slug === entry.slug ? " active" : "") + '" href="' + p.slug + '.html">' + esc(p.title) + "</a>").join("\n"),
    "        </div>",
  ].join("\n")).join("\n");
  const toc = entry.headings.length
    ? ['    <nav class="toc" aria-label="On this page">', '      <div class="toc-title">On this page</div>']
      .concat(entry.headings.map((h) => "      <a" + (h.level === 3 ? ' class="sub"' : "") + ' href="#' + h.id + '">' + esc(h.text) + "</a>"))
      .concat(["    </nav>"]).join("\n")
    : "";
  const step = (cls, label, to) => (to ? '<a class="' + cls + '" href="' + to.slug + '.html"><span class="pn-label">' + label + '</span><span class="pn-title">' + esc(to.title) + "</span></a>" : "<span></span>");
  const plain = entry.lead.replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*/g, "");
  // this page in another release, or that release's first page when it has none
  const there = (other) => (other === latest ? docs : docs + minor(other.version) + "/") + (other.slugs.has(entry.slug) ? entry.slug : "index") + ".html";
  const menu = guides.map((other) => '        <a href="' + there(other) + '"' + (other === guide ? ' aria-current="true"' : "") + ">v" + other.version + (other === latest ? " <span>latest</span>" : "") + "</a>").join("\n");
  const stale = guide === latest ? "" : '      <div class="callout version-note"><p>This is the guide for Mach ' + guide.version + '. <a href="' + there(latest) + '">The latest is ' + latest.version + ".</a></p></div>\n";
  // one address stands for a page: the newest release's, wherever it exists
  const canonical = latest.slugs.has(entry.slug) ? '\n  <link rel="canonical" href="' + SITE + "/docs/" + entry.slug + '.html">' : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mach docs: ${esc(entry.title)}</title>
  <meta name="description" content="${esc(plain)}">${canonical}
  <link rel="icon" type="image/svg+xml" href="${site}assets/mach-tile.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="${site}assets/mach_32.png">
  <link rel="stylesheet" href="${docs}docs.css">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
  <link rel="alternate" type="text/plain" href="/llms-full.txt" title="llms-full.txt">
</head>
<body>

  <header class="topbar">
    <button class="menu-toggle" aria-label="Toggle navigation"><span></span></button>
    <a class="brand" href="index.html">
      <img src="${site}assets/mach.svg" alt="" width="22" height="22">
      <span>mach</span><span class="brand-docs">docs</span>
    </a>
    <details class="version-menu">
      <summary class="badge" aria-label="The release this guide describes">v${guide.version}</summary>
      <div class="version-list">
${menu}
      </div>
    </details>
    <div class="topbar-spacer"></div>
    <button class="search-trigger" aria-label="Search the docs">
      <span class="st-text">Search</span><span class="kbd">Ctrl K</span>
    </button>
    <div class="topbar-actions">
      <a href="${site}index.html">Home</a>
      <a href="${site}playground/">Playground</a>
      <a href="${site}ecosystem/">Ecosystem</a>
      <a href="${REPO}/blob/main/CHANGELOG.md" target="_blank" rel="noopener">Changelog</a>
      <a href="https://discord.com/invite/dfWG9NhGj7" target="_blank" rel="noopener" class="topbar-icon" aria-label="Mach on Discord" title="Discord"><svg aria-hidden="true"><use href="${icons}#discord" /></svg></a>
      <a href="${REPO}" target="_blank" rel="noopener" class="topbar-icon" aria-label="Mach on GitHub" title="GitHub"><svg aria-hidden="true"><use href="${icons}#github" /></svg></a>
    </div>
  </header>

  <div class="docs-layout">
    <aside class="sidebar">
      <nav>
${sidebar}
      </nav>
    </aside>

    <main class="content">
${stale}      <div class="breadcrumb"><a href="index.html">Docs</a><span class="sep">/</span>${esc(group)}<span class="sep">/</span>${esc(entry.title)}</div>
      <h1>${esc(entry.title)}</h1>
      <p class="lead">${entry.leadHtml}</p>

${entry.html}

      <div class="page-nav">${step("prev", "Previous", prev)}${step("next", "Next", next)}</div>
    </main>

${toc}
  </div>

  <footer class="bar">
    <div class="bar-inner">
      <span class="bar-brand"><img src="${site}assets/mach-tile.svg" alt="" width="18" height="18">mach v${esc(guide.version)}</span>
      <span class="bar-links">
        <a href="${site}index.html">home</a>
        <a href="${site}playground/">playground</a>
        <a href="${site}ecosystem/">ecosystem</a>
        <a href="${REPO}" target="_blank">github</a>
        <a href="https://discord.com/invite/dfWG9NhGj7" target="_blank">discord</a>
        <a href="${REPO}/releases" target="_blank">releases</a>
      </span>
      <span>&copy; 2026 Briar Systems LLC · MIT License</span>
    </div>
  </footer>

  <div class="palette" aria-hidden="true">
    <div class="palette-box" role="dialog" aria-label="Search the docs">
      <div class="palette-head">
        <span class="palette-prompt">/</span>
        <input class="palette-input" type="text" placeholder="Search the docs" aria-label="Search the docs">
      </div>
      <div class="palette-list"></div>
    </div>
  </div>

  <script src="search.js" defer></script>
  <script src="${docs}docs.js" defer></script>
</body>
</html>
`;
}

// one release's guide: every page in nav order under its group, read and
// rendered, with its links into the mach repository opening at ref
function load(src, ref) {
  const nav = JSON.parse(fs.readFileSync(path.join(src, "nav.json"), "utf8"));
  const listed = new Set();
  const groups = nav.groups.map((g) => ({
    group: g.group,
    pages: g.pages.map((name) => {
      listed.add(name + ".md");
      const markdown = fs.readFileSync(path.join(src, name + ".md"), "utf8");
      return Object.assign({ slug: name, markdown }, render(markdown, name + ".md", ref));
    }),
  }));
  for (const file of fs.readdirSync(src)) {
    if (file.endsWith(".md") && file !== "README.md" && !listed.has(file)) { throw new Error(file + " is in no group of nav.json"); }
  }
  const guide = { groups, moved: nav.moved || {}, slugs: new Set(groups.flatMap((g) => g.pages).map((p) => p.slug)) };
  checkLinks(guide);
  return guide;
}

// every link between pages names a page that exists and, with a #, a heading on it
function checkLinks(guide) {
  const pages = guide.groups.flatMap((g) => g.pages);
  const ids = new Map(pages.map((p) => [p.slug, p.ids]));
  for (const p of pages) {
    for (const target of targets(p.markdown)) {
      const to = link(target, p.slug + ".md");
      if (to.kind !== "page" && to.kind !== "anchor") { continue; }
      const name = to.kind === "page" ? to.page : p.slug;
      if (!ids.has(name)) { throw new Error(p.slug + ".md links to " + name + ".md, which is no page"); }
      if (to.hash && !ids.get(name).has(to.hash.slice(1))) { throw new Error(p.slug + ".md links to " + name + to.hash + ", which is no heading there"); }
    }
  }
}

// every link target in a page's prose, outside its code
function targets(markdown) {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]+`/g, "");
  return Array.from(prose.matchAll(/\]\(([^)\s]+)\)/g), (m) => m[1]);
}

// the releases a guides directory holds, newest first
function versions(guides) {
  const found = fs.readdirSync(guides).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(newer);
  if (!found.length) { throw new Error(guides + " holds no guide: fetch-guide.js lays each release's out there as <version>/"); }
  const minors = found.map(minor);
  const twice = minors.find((m, n) => minors.indexOf(m) !== n);
  if (twice) { throw new Error(guides + " holds two releases of " + twice + ", and one address stands for both"); }
  return found;
}

// one release's pages, its retired addresses and its search index, in one directory
function write(at, guide, out) {
  const flat = guide.groups.flatMap((g) => g.pages.map((p) => ({ group: g.group, entry: p })));
  fs.mkdirSync(out, { recursive: true });
  flat.forEach((item, n) => {
    const prev = n > 0 ? flat[n - 1].entry : null;
    const next = n + 1 < flat.length ? flat[n + 1].entry : null;
    fs.writeFileSync(path.join(out, item.entry.slug + ".html"), page(at, guide, item.group, item.entry, prev, next));
  });
  // a page that was folded into another leaves its address behind, pointing at where it went
  for (const old of Object.keys(guide.moved)) {
    const to = guide.moved[old];
    fs.writeFileSync(path.join(out, old + ".html"), '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>mach docs: moved</title>\n  <link rel="canonical" href="' + to + '">\n  <meta http-equiv="refresh" content="0; url=' + to + '">\n</head>\n<body>\n  <p>This page moved to <a href="' + to + '">' + to + "</a>.</p>\n</body>\n</html>\n");
  }
  const index = flat.map((item) => ({
    title: item.entry.title,
    group: item.group,
    url: item.entry.slug + ".html",
    sections: item.entry.headings.map((h) => ({ title: h.text, id: h.id })),
  }));
  fs.writeFileSync(path.join(out, "search.js"), "// generated by .github/scripts/build-docs.js. do not edit.\nwindow.machDocs = " + JSON.stringify(index) + ";\n");
}

// every release under guides, each a version directory. refs names the branch
// a release's links into the repository open at where that is not its tag, as
// a guide read from a branch before its release has no tag to open.
// versions.json lists the releases built, newest first: the server reads it to
// tell when mach has a release these pages do not hold
function build(guides, out, refs = {}) {
  const loaded = versions(guides).map((version) => Object.assign(load(path.join(guides, version), refs[version] || "v" + version), { version }));
  const latest = loaded[0];
  for (const guide of loaded) {
    write({ docs: "../", site: "../../", guides: loaded, latest }, guide, path.join(out, minor(guide.version)));
  }
  write({ docs: "", site: "../", guides: loaded, latest }, latest, out);
  fs.writeFileSync(path.join(out, "versions.json"), JSON.stringify(loaded.map((guide) => guide.version)) + "\n");
  return loaded;
}

if (require.main === module) {
  const guides = path.resolve(process.argv[2] || path.join(ROOT, "out", "guide"));
  const out = path.resolve(process.argv[3] || path.join(ROOT, "public", "docs"));
  try {
    const refs = fs.existsSync(path.join(guides, "refs.json")) ? JSON.parse(fs.readFileSync(path.join(guides, "refs.json"), "utf8")) : {};
    const loaded = build(guides, out, refs);
    console.log(`built the guide of ${loaded.map((g) => g.version).join(", ")} into ${out}`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { render, load, build, versions, minor, slug, link, REPO, SITE };
