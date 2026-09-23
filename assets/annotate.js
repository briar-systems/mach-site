// annotated example: fetches a .mach file, drops comment-only lines, and pins
// each note to the first line whose source contains the note's match text, so
// the example can change without its notes drifting to the wrong line.
(function () {
  var hl = window.machHighlight;
  if (!hl) return;

  function rows(text, notes) {
    var lines = text.replace(/\n+$/, "").split("\n").filter(function (l) {
      return !/^\s*#(?!\[)/.test(l);
    });
    lines = lines.filter(function (l, i) {
      return l.trim() !== "" || (i > 0 && lines[i - 1].trim() !== "");
    });
    var used = {};
    return lines.map(function (line, i) {
      var k = -1;
      notes.forEach(function (n, j) {
        if (k < 0 && !used[j] && line.indexOf(n.match) !== -1) k = j;
      });
      if (k >= 0) used[k] = true;
      var hot = k >= 0;
      return '<div class="ann-row' + (hot ? " is-hot" : "") + '">' +
        '<span class="ann-n">' + (i + 1) + "</span>" +
        '<span class="ann-src">' + (line ? hl.tokenize(line) : " ") + "</span>" +
        '<span class="ann-note">' + (hot ? '<b>' + (k + 1) + "</b>" + notes[k].html : "") + "</span>" +
        "</div>";
    }).join("");
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-annotate]"), function (root) {
    var out = root.querySelector(".ann-code");
    var notes = Array.prototype.map.call(root.querySelectorAll("[data-match]"), function (li) {
      return { match: li.getAttribute("data-match"), html: li.innerHTML };
    });
    fetch(root.getAttribute("data-annotate"))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        out.innerHTML = rows(text, notes);
        root.classList.add("is-ready");
      })
      .catch(function (err) {
        // the plain note list stays in place as the fallback
        console.warn("annotate: failed to load " + root.getAttribute("data-annotate"), err);
      });
  });
}());
