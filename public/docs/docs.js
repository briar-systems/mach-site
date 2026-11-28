// docs shell: mobile nav, on-this-page scroll-spy, and a command-palette search
// over every page and heading.
(function () {
  // what the palette searches: every page and every heading on it, as
  // search.js lists them (built with the pages by .github/scripts/build-docs.js)
  var ENTRIES = [];
  (window.machDocs || []).forEach(function (p) {
    ENTRIES.push({ title: p.title, where: p.group, url: p.url, page: true });
    p.sections.forEach(function (s) {
      ENTRIES.push({ title: s.title, where: p.title, url: p.url + "#" + s.id, page: false });
    });
  });

  // --- version menu: a click elsewhere or Escape closes it ---
  var versions = document.querySelector(".version-menu");
  if (versions) {
    document.addEventListener("click", function (e) {
      if (versions.open && !versions.contains(e.target)) { versions.open = false; }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { versions.open = false; }
    });
  }

  // --- mobile sidebar ---
  var toggle = document.querySelector(".menu-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () { document.body.classList.toggle("nav-open"); });
  }
  document.querySelectorAll(".sidebar .nav-link").forEach(function (a) {
    a.addEventListener("click", function () { document.body.classList.remove("nav-open"); });
  });

  // --- on-this-page scroll-spy ---
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var headings = tocLinks
      .map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); })
      .filter(Boolean);
    var current = null;
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) current = e.target.id;
      });
      tocLinks.forEach(function (a) { a.classList.remove("active"); });
      if (current && byId[current]) byId[current].classList.add("active");
    }, { rootMargin: "-15% 0px -70% 0px", threshold: 0 });
    headings.forEach(function (h) { spy.observe(h); });
  }

  // --- command palette ---
  var palette = document.querySelector(".palette");
  var trigger = document.querySelector(".search-trigger");
  if (palette && trigger) {
    var input = palette.querySelector(".palette-input");
    var list = palette.querySelector(".palette-list");
    var sel = 0;
    var shown = [];

    function esc(t) {
      return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // pages first when nothing is typed. a query ranks a title that starts
    // with it over one that holds it, and a page over a heading
    function matches(q) {
      if (!q) { return ENTRIES.filter(function (e) { return e.page; }); }
      var hits = [];
      ENTRIES.forEach(function (e) {
        var at = e.title.toLowerCase().indexOf(q);
        var near = at === -1 ? (e.where.toLowerCase().indexOf(q) === -1 ? -1 : 2) : (at === 0 ? 0 : 1);
        if (near !== -1) { hits.push({ e: e, rank: near * 2 + (e.page ? 0 : 1) }); }
      });
      hits.sort(function (a, b) { return a.rank - b.rank; });
      return hits.slice(0, 40).map(function (h) { return h.e; });
    }

    function render() {
      shown = matches(input.value.trim().toLowerCase());
      if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
      if (!shown.length) { list.innerHTML = '<div class="palette-empty">No matches.</div>'; return; }
      list.innerHTML = shown.map(function (p, i) {
        return '<div class="palette-item' + (i === sel ? " active" : "") + '" data-i="' + i + '">' +
          '<span class="pi-title">' + esc(p.title) + '</span>' +
          '<span class="pi-group">' + esc(p.where) + '</span></div>';
      }).join("");
      var active = list.querySelector(".palette-item.active");
      if (active) { active.scrollIntoView({ block: "nearest" }); }
    }
    function open() {
      palette.classList.add("open");
      input.value = ""; sel = 0; render();
      input.focus();
    }
    function close() { palette.classList.remove("open"); }
    function go(i) {
      var p = shown[i];
      close();
      if (p) { window.location.href = p.url; }
    }

    trigger.addEventListener("click", open);
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
      else if (e.key === "Escape" && palette.classList.contains("open")) { close(); }
    });
    input.addEventListener("input", render);
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter") { go(sel); }
    });
    list.addEventListener("click", function (e) {
      var item = e.target.closest(".palette-item");
      if (item) go(parseInt(item.getAttribute("data-i"), 10));
    });
    palette.addEventListener("click", function (e) { if (e.target === palette) close(); });
  }
}());
