// mach cone banner: draws the wavefronts a body at mach M leaves behind, the
// shock envelope they share, and animates them. everything follows from M, the
// apex position and the wavefront speed, through sin(mu) = 1 / M.
(function () {
  var svg = document.querySelector("svg[data-cone]");
  if (!svg) return;

  var NS = "http://www.w3.org/2000/svg";
  var box = svg.viewBox.baseVal;
  var M = parseFloat(svg.getAttribute("data-cone")) || 2;
  var ax = parseFloat(svg.getAttribute("data-apex-x"));
  var ay = parseFloat(svg.getAttribute("data-apex-y"));
  var C = 42;                  // wavefront radius gained per unit time
  var V = C * M;               // distance the body covers per unit time
  var LIFE = ax / V;           // time until a wavefront's centre leaves the frame
  var PERIOD = 9000;           // ms for one wavefront to live out its LIFE
  var COUNT = 12;              // wavefronts alive at once
  var sin = 1 / M, cos = Math.sqrt(1 - sin * sin), tan = sin / cos;

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(n);
    return n;
  }

  // axis, ticks and the frozen wavefronts behind the moving ones
  el("line", { x1: 0, y1: ay, x2: box.width, y2: ay, class: "cone-axis" });
  for (var x = 0; x <= box.width; x += 40) {
    el("line", { x1: x, y1: box.height, x2: x, y2: box.height - (x % 200 === 0 ? 14 : 7), class: "cone-tick" });
  }
  for (var k = 1; k <= Math.floor(LIFE); k++) {
    el("circle", { cx: ax - V * k, cy: ay, r: C * k, class: "cone-front is-static" });
  }

  // live wavefronts, and the points where each one touches the envelope
  var live = [];
  for (var i = 0; i < COUNT; i++) {
    live.push({
      ring: el("circle", { cx: ax, cy: ay, r: 0, class: "cone-front" }),
      hi: el("circle", { cx: ax, cy: ay, r: 3, class: "cone-touch" }),
      lo: el("circle", { cx: ax, cy: ay, r: 3, class: "cone-touch" }),
      offset: i / COUNT
    });
  }

  // envelope, angle, velocity and the body itself, drawn over the wavefronts
  var reach = ax + 40;
  el("line", { x1: ax, y1: ay, x2: ax - reach, y2: ay - reach * tan, class: "cone-shock" });
  el("line", { x1: ax, y1: ay, x2: ax - reach, y2: ay + reach * tan, class: "cone-shock" });
  var R = 130;
  el("path", { d: "M " + (ax - R) + " " + ay + " A " + R + " " + R + " 0 0 1 " + (ax - R * cos) + " " + (ay - R * sin), class: "cone-guide" });
  el("text", { x: ax - R - 32, y: ay - 14, class: "cone-label" }).textContent = "μ";
  el("path", { d: "M " + (ax + 14) + " " + ay + " h 50 m -9 -7 l 9 7 l -9 7", class: "cone-guide" });
  el("text", { x: ax + 30, y: ay - 16, class: "cone-label" }).textContent = "v";
  el("circle", { cx: ax, cy: ay, r: 8, class: "cone-body" });
  var mu = Math.asin(sin) * 180 / Math.PI;
  el("text", { x: box.width - 56, y: 48, class: "cone-readout" }).textContent =
    "M " + M.toFixed(2) + "   μ " + mu.toFixed(1) + "°   sin μ = 1/M";

  // places every live wavefront at time t (ms)
  function frame(t) {
    live.forEach(function (w) {
      var p = ((t / PERIOD) + w.offset) % 1;
      var age = p * LIFE;
      var d = V * age;
      w.ring.setAttribute("cx", ax - d);
      w.ring.setAttribute("r", C * age);
      w.ring.style.opacity = String(0.8 * (1 - p));
      var tx = ax - d * cos * cos, ty = d * cos * sin;
      w.hi.setAttribute("cx", tx); w.hi.setAttribute("cy", ay - ty);
      w.lo.setAttribute("cx", tx); w.lo.setAttribute("cy", ay + ty);
      w.hi.style.opacity = w.lo.style.opacity = String(1 - p);
    });
  }

  if (reduce) {
    live.forEach(function (w) { w.ring.remove(); w.hi.remove(); w.lo.remove(); });
    return;
  }

  var raf = 0, visible = true;
  function tick(t) { frame(t); raf = visible ? requestAnimationFrame(tick) : 0; }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(tick);
    }).observe(svg);
  }
  raf = requestAnimationFrame(tick);
}());
