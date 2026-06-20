// cross-compilation target reel: spins through build targets and keeps the
// build command and matching mach.toml stanza in sync with the centered target.
(function () {
  var reel = document.querySelector(".xc-reel");
  if (!reel) return;
  var items = Array.prototype.slice.call(reel.querySelectorAll(".reel-item"));
  if (!items.length) return;

  var targetEl = document.querySelector(".xc-target");
  var statusEl = document.querySelector(".xc-status");
  var stanzaEl = document.querySelector("[data-stanza]");
  var stanzaPre = document.querySelector(".xc-stanza");
  var len = items.length;

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // cylinder geometry for the 3D reel
  var ANGLE = 20;    // degrees between adjacent targets
  var RADIUS = 142;  // px from the cylinder axis
  var VISIBLE = 2;   // targets shown on each side of center
  var STEP = 64;     // px between targets in the reduced-motion flat layout

  // the [target.<name>] stanza shown for each target
  var STANZA = {
    "linux":       '[target.linux]\nisa = "x86_64"\nos  = "linux"\nabi = "sysv64"',
    "windows":     '[target.windows]\nisa  = "x86_64"\nos   = "windows"\nabi  = "win64"\next  = ".exe"\nlibs = ["kernel32.dll"]',
    "linux-arm64": '[target.linux-arm64]\nisa = "aarch64"\nos  = "linux"\nabi = "aapcs64"',
    "macos":       '[target.macos]\nisa = "aarch64"\nos  = "darwin"\nabi = "aapcs64"',
    "wasm":        '[target.wasm]\nisa = "wasm32"\nos  = "wasi"\nabi = "wasi"',
    "riscv64":     '[target.riscv64]\nisa = "riscv64"\nos  = "linux"\nabi = "lp64"'
  };

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // minimal TOML highlighter for the manifest stanza
  function highlightToml(src) {
    return src.split("\n").map(function (line) {
      if (line.charAt(0) === "[") {
        return '<span class="toml-head">' + esc(line) + "</span>";
      }
      var m = line.match(/^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.*)$/);
      if (!m) return esc(line);
      var value = esc(m[4]).replace(/"[^"]*"/g, function (s) {
        return '<span class="str">' + s + "</span>";
      });
      return esc(m[1]) + '<span class="toml-key">' + esc(m[2]) + "</span>" + esc(m[3]) + value;
    }).join("\n");
  }

  function statusLine(name, status) {
    if (status === "supported") return '# linked -&gt; out/<span class="xc-out">' + esc(name) + "</span>/bin/app";
    if (status === "planned") return "# codegen in progress";
    return "# on the roadmap";
  }

  function flash(el) {
    if (reduce || !el) return;
    el.classList.remove("is-swap");
    void el.offsetWidth; // restart the animation
    el.classList.add("is-swap");
  }

  var active = 0;
  var current = -1;

  function sync() {
    var item = items[active];
    var name = item.getAttribute("data-target");
    var status = item.getAttribute("data-status");
    if (active === current) return;
    current = active;

    targetEl.textContent = name;
    flash(targetEl);

    statusEl.setAttribute("data-status", status);
    statusEl.innerHTML = statusLine(name, status);

    stanzaEl.innerHTML = highlightToml(STANZA[name] || "");
    if (!reduce) {
      stanzaPre.classList.remove("is-fade");
      void stanzaPre.offsetWidth;
      stanzaPre.classList.add("is-fade");
    }
  }

  function circOffset(i) {
    var d = i - active;
    while (d > len / 2) d -= len;
    while (d < -len / 2) d += len;
    return d;
  }

  function layout() {
    items.forEach(function (item, i) {
      var d = circOffset(i);
      var hidden = Math.abs(d) > VISIBLE;
      item.style.visibility = hidden ? "hidden" : "visible";
      item.classList.toggle("is-active", d === 0);
      item.setAttribute("aria-selected", d === 0 ? "true" : "false");
      if (reduce) {
        item.style.transform = "translateY(" + d * STEP + "px)";
        item.style.opacity = d === 0 ? "1" : "0.4";
      } else {
        item.style.transform = "rotateX(" + (-d * ANGLE) + "deg) translateZ(" + RADIUS + "px)";
        item.style.opacity = hidden ? "0" : String(Math.max(0, 1 - Math.abs(d) * 0.32));
      }
    });
    sync();
  }

  // playback, gated on visibility and pointer/focus
  var iv = null, hovered = false, visible = true;

  function update() {
    if (iv) { clearInterval(iv); iv = null; }
    if (!reduce && visible && !hovered) {
      iv = setInterval(function () { active = (active + 1) % len; layout(); }, 2600);
    }
  }

  reel.addEventListener("mouseenter", function () { hovered = true; update(); });
  reel.addEventListener("mouseleave", function () { hovered = false; update(); });
  reel.addEventListener("focusin", function () { hovered = true; update(); });
  reel.addEventListener("focusout", function () { hovered = false; update(); });

  items.forEach(function (item, i) {
    item.addEventListener("click", function () { active = i; layout(); });
  });

  reel.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      active = (active - 1 + len) % len; layout(); e.preventDefault();
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      active = (active + 1) % len; layout(); e.preventDefault();
    }
  });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible = en.isIntersecting; update(); });
    }, { threshold: 0.25 }).observe(reel);
  }

  layout();
  update();
}());
