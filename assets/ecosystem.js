// the ecosystem page. reads the data.json the deploy bakes from mach-ecosystem
// (.github/scripts/bake-ecosystem.js) and renders it as a filterable catalog.
// the view state lives in the query string so a filtered view can be linked.
(function () {
  "use strict";

  var DATA_URL = "data.json";
  var DEFAULTS = { q: "", category: "all", source: "all", sort: "stars" };
  var SORTS = {
    stars: "most stars",
    updated: "recently updated",
    release: "latest release",
    name: "name",
  };
  var SOURCES = { all: "all", official: "official", community: "community" };

  function readState(search) {
    var params = new URLSearchParams(search || "");
    var state = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      state[k] = params.get(k) || DEFAULTS[k];
    });
    if (!SORTS.hasOwnProperty(state.sort)) { state.sort = DEFAULTS.sort; }
    if (!SOURCES.hasOwnProperty(state.source)) { state.source = DEFAULTS.source; }
    return state;
  }

  // the query string for a state, leaving out anything at its default
  function writeState(state) {
    var params = new URLSearchParams();
    Object.keys(DEFAULTS).forEach(function (k) {
      if (state[k] && state[k] !== DEFAULTS[k]) { params.set(k, state[k]); }
    });
    var s = params.toString();
    return s ? "?" + s : "";
  }

  function terms(q) {
    return (q || "").toLowerCase().split(/\s+/).filter(Boolean);
  }

  // every term must appear in the entry's name, description, repo or category title
  function matches(entry, words, titles) {
    if (!words.length) { return true; }
    var hay = [
      entry.name,
      entry.description,
      entry.github ? entry.github.repo : entry.url,
      titles[entry.category] || entry.category,
    ].join(" ").toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) > -1; });
  }

  function inSource(entry, source) {
    if (source === "official") { return entry.official; }
    if (source === "community") { return !entry.official; }
    return true;
  }

  // a metric to sort descending by. entries without github metadata sort last
  function metric(entry, sort) {
    var g = entry.github;
    if (!g) { return -Infinity; }
    if (sort === "stars") { return g.stars; }
    if (sort === "updated") { return Date.parse(g.pushed) || -Infinity; }
    if (sort === "release") { return g.release ? Date.parse(g.release.published) : -Infinity; }
    return 0;
  }

  function byName(a, b) {
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
  }

  function sortEntries(entries, sort) {
    return entries.slice().sort(function (a, b) {
      if (sort !== "name") {
        var d = metric(b, sort) - metric(a, sort);
        if (d > 0 || d < 0) { return d; }
      }
      return byName(a, b);
    });
  }

  function titlesOf(data) {
    var titles = {};
    data.categories.forEach(function (c) { titles[c.id] = c.title; });
    return titles;
  }

  // entries matching the search and source, before the category filter, so the
  // category chips can count what each would show
  function searched(data, state) {
    var words = terms(state.q);
    var titles = titlesOf(data);
    return data.entries.filter(function (e) {
      return inSource(e, state.source) && matches(e, words, titles);
    });
  }

  function select(data, state) {
    var pool = searched(data, state).filter(function (e) {
      return state.category === "all" || e.category === state.category;
    });
    return sortEntries(pool, state.sort);
  }

  // true once the listing mixes official and community projects
  function hasSources(data) {
    var official = data.entries.filter(function (e) { return e.official; }).length;
    return official > 0 && official < data.entries.length;
  }

  function relative(iso, now) {
    var then = Date.parse(iso);
    if (isNaN(then)) { return ""; }
    var days = Math.floor((now - then) / 86400000);
    if (days < 1) { return "today"; }
    if (days === 1) { return "yesterday"; }
    if (days < 30) { return days + " days ago"; }
    var months = Math.floor(days / 30);
    if (months < 12) { return months === 1 ? "a month ago" : months + " months ago"; }
    var years = Math.floor(days / 365);
    return years <= 1 ? "a year ago" : years + " years ago";
  }

  function compact(n) {
    if (n < 1000) { return String(n); }
    var k = n / 1000;
    return (k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)) + "k";
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text != null) { node.textContent = text; }
    return node;
  }

  function host(url) {
    try { return new URL(url).host; } catch (e) { return url; }
  }

  function card(entry, titles, now, showSource) {
    var g = entry.github;
    var root = el("article", "panel eco-card");

    var head = el("div", "eco-card-head");
    var name = el("a", "eco-name", entry.name);
    name.href = entry.url;
    name.target = "_blank";
    name.rel = "noopener";
    head.appendChild(name);
    var tags = el("div", "eco-tags");
    if (showSource && entry.official) { tags.appendChild(el("span", "chip chip-official", "official")); }
    var cat = el("button", "chip eco-cat", titles[entry.category] || entry.category);
    cat.type = "button";
    cat.setAttribute("data-category", entry.category);
    cat.title = "show only " + (titles[entry.category] || entry.category);
    tags.appendChild(cat);
    head.appendChild(tags);
    root.appendChild(head);

    root.appendChild(el("p", "eco-repo", g ? g.repo : host(entry.url)));
    root.appendChild(el("p", "eco-desc", entry.description));

    if (g) {
      var meta = el("ul", "eco-meta");
      var stars = el("li", "eco-stars", compact(g.stars));
      stars.setAttribute("aria-label", g.stars + " stars");
      meta.appendChild(stars);
      if (g.release) { meta.appendChild(el("li", null, g.release.tag)); }
      if (g.license) { meta.appendChild(el("li", null, g.license)); }
      var pushed = el("li", null, "updated " + relative(g.pushed, now));
      pushed.title = g.pushed.slice(0, 10);
      meta.appendChild(pushed);
      root.appendChild(meta);
    }
    return root;
  }

  function chip(label, count, pressed, attr, value) {
    var b = el("button", "eco-chip");
    b.type = "button";
    b.setAttribute(attr, value);
    b.setAttribute("aria-pressed", pressed ? "true" : "false");
    b.appendChild(document.createTextNode(label));
    if (count != null) { b.appendChild(el("span", "eco-count", String(count))); }
    return b;
  }

  function start(root) {
    var state = readState(location.search);
    var data = null;
    var ui = {
      search: root.querySelector("#eco-search"),
      sort: root.querySelector("#eco-sort"),
      categories: root.querySelector(".eco-categories"),
      sources: root.querySelector(".eco-sources"),
      stats: root.querySelector(".eco-stats"),
      status: root.querySelector(".eco-status"),
      grid: root.querySelector(".eco-grid"),
      empty: root.querySelector(".eco-empty"),
    };

    Object.keys(SORTS).forEach(function (k) {
      var o = el("option", null, SORTS[k]);
      o.value = k;
      ui.sort.appendChild(o);
    });

    function set(patch) {
      Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
      history.replaceState(null, "", location.pathname + writeState(state) + location.hash);
      render();
    }

    function render() {
      var titles = titlesOf(data);
      var now = Date.now();
      var pool = searched(data, state);
      var shown = select(data, state);
      var mixed = hasSources(data);

      if (ui.search.value !== state.q) { ui.search.value = state.q; }
      ui.sort.value = state.sort;

      ui.categories.textContent = "";
      ui.categories.appendChild(chip("all", pool.length, state.category === "all", "data-category", "all"));
      data.categories.forEach(function (c) {
        var n = pool.filter(function (e) { return e.category === c.id; }).length;
        var b = chip(c.title, n, state.category === c.id, "data-category", c.id);
        if (n === 0) { b.classList.add("is-empty"); }
        ui.categories.appendChild(b);
      });

      ui.sources.hidden = !mixed;
      ui.sources.textContent = "";
      if (mixed) {
        Object.keys(SOURCES).forEach(function (k) {
          ui.sources.appendChild(chip(SOURCES[k], null, state.source === k, "data-source", k));
        });
      }

      ui.grid.textContent = "";
      shown.forEach(function (e) { ui.grid.appendChild(card(e, titles, now, mixed)); });
      ui.empty.hidden = shown.length > 0;
      ui.status.textContent = shown.length === data.entries.length
        ? "showing all " + shown.length + " projects"
        : "showing " + shown.length + " of " + data.entries.length + " projects";
    }

    root.addEventListener("click", function (e) {
      var c = e.target.closest("[data-category]");
      if (c) { set({ category: c.getAttribute("data-category") }); return; }
      var s = e.target.closest("[data-source]");
      if (s) { set({ source: s.getAttribute("data-source") }); return; }
      if (e.target.closest(".eco-reset")) { set({ q: "", category: "all", source: "all" }); }
    });
    ui.search.addEventListener("input", function () { set({ q: ui.search.value }); });
    ui.sort.addEventListener("change", function () { set({ sort: ui.sort.value }); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== ui.search && !/^(input|select|textarea)$/i.test(document.activeElement.tagName)) {
        e.preventDefault();
        ui.search.focus();
      }
    });

    fetch(DATA_URL)
      .then(function (res) {
        if (!res.ok) { throw new Error(res.status); }
        return res.json();
      })
      .then(function (body) {
        data = body;
        var cats = data.categories.length;
        ui.stats.textContent = data.entries.length + " projects · " + cats + " categories · refreshed " + relative(data.generated, Date.now());
        root.classList.add("is-ready");
        render();
      })
      .catch(function () {
        root.classList.add("is-failed");
      });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      readState: readState,
      writeState: writeState,
      matches: matches,
      terms: terms,
      sortEntries: sortEntries,
      select: select,
      searched: searched,
      hasSources: hasSources,
      relative: relative,
      compact: compact,
    };
  } else if (typeof document !== "undefined") {
    var boot = function () {
      var root = document.querySelector("[data-ecosystem]");
      if (root) { start(root); }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})();
