// client-side mach syntax highlighter: tokenizes .mach source and renders it
// with the site's existing token CSS classes, preserving whitespace verbatim.
(function () {
  "use strict";

  var KEYWORDS = {
    fun: 1, if: 1, for: 1, ret: 1, var: 1, val: 1, ext: 1, pub: 1, def: 1,
    rec: 1, uni: 1, fwd: 1, test: 1, asm: 1, break: 1, continue: 1, else: 1,
    in: 1, use: 1
  };

  var PRIMITIVES = {
    i8: 1, i16: 1, i32: 1, i64: 1, u8: 1, u16: 1, u32: 1, u64: 1,
    usize: 1, isize: 1, f32: 1, f64: 1, bool: 1, str: 1, ptr: 1, void: 1
  };

  // escapes a raw source fragment for safe insertion as HTML text.
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // wraps an escaped fragment in a token span, or returns it plain.
  function span(cls, raw) {
    return cls ? '<span class="' + cls + '">' + esc(raw) + "</span>" : esc(raw);
  }

  function isSpace(c) {
    return c === " " || c === "\n" || c === "\t" || c === "\r";
  }
  function isIdentStart(c) {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  }
  function isIdentPart(c) {
    return isIdentStart(c) || (c >= "0" && c <= "9");
  }
  function isDigit(c) {
    return c >= "0" && c <= "9";
  }
  function isUpper(c) {
    return c >= "A" && c <= "Z";
  }

  // index of the next non-space char at or after i, or src.length.
  function skipSpaces(src, i) {
    while (i < src.length && isSpace(src.charAt(i))) i++;
    return i;
  }

  // tokenizes mach source into highlighted HTML, preserving all whitespace.
  function tokenize(src) {
    var out = "";
    var i = 0;
    var n = src.length;
    var prevKw = null; // last significant (non-space) identifier classified as a keyword

    while (i < n) {
      var c = src.charAt(i);

      // 1. whitespace: emit verbatim, no span.
      if (isSpace(c)) {
        var ws = i;
        while (i < n && isSpace(src.charAt(i))) i++;
        out += esc(src.slice(ws, i));
        continue;
      }

      // 2/3. comment or decorator (both begin with '#').
      if (c === "#") {
        if (src.charAt(i + 1) === "[") {
          // decorator: consume up to and including the matching ']'.
          var d = i + 2;
          while (d < n && src.charAt(d) !== "]") {
            if (src.charAt(d) === '"') {
              d = d + 1;
              while (d < n && src.charAt(d) !== '"') {
                if (src.charAt(d) === "\\") d++;
                d++;
              }
              if (d < n) d++; // closing quote
            } else {
              d++;
            }
          }
          if (d < n) d++; // closing ']'
          out += emitDecorator(src.slice(i, d));
          i = d;
          continue;
        }
        // line comment: consume to end of line.
        var cm = i;
        while (i < n && src.charAt(i) !== "\n") i++;
        out += span("cmt", src.slice(cm, i));
        continue;
      }

      // 4. string literal.
      if (c === '"') {
        var s = i + 1;
        while (s < n && src.charAt(s) !== '"') {
          if (src.charAt(s) === "\\") s++;
          s++;
        }
        if (s < n) s++; // closing quote
        out += span("str", src.slice(i, s));
        i = s;
        continue;
      }

      // 5. char literal.
      if (c === "'") {
        var ch = i + 1;
        while (ch < n && src.charAt(ch) !== "'") {
          if (src.charAt(ch) === "\\") ch++;
          ch++;
        }
        if (ch < n) ch++; // closing quote
        out += span("str", src.slice(i, ch));
        i = ch;
        continue;
      }

      // 6. ellipsis token.
      if (c === "." && src.charAt(i + 1) === "." && src.charAt(i + 2) === ".") {
        out += span("ct", "...");
        i += 3;
        continue;
      }

      // 7. comptime intrinsic: '$' + identifier.
      if (c === "$" && isIdentStart(src.charAt(i + 1))) {
        var ct = i + 1;
        while (ct < n && isIdentPart(src.charAt(ct))) ct++;
        out += span("ct", src.slice(i, ct));
        i = ct;
        continue;
      }

      // 8. number (decimal or hex).
      if (isDigit(c)) {
        var num = i;
        if (c === "0" && (src.charAt(i + 1) === "x" || src.charAt(i + 1) === "X")) {
          num = i + 2;
          while (num < n && /[0-9a-fA-F_]/.test(src.charAt(num))) num++;
        } else {
          num = i + 1;
          while (num < n && /[0-9_]/.test(src.charAt(num))) num++;
        }
        out += span("num", src.slice(i, num));
        i = num;
        continue;
      }

      // identifier or keyword.
      if (isIdentStart(c)) {
        var id = i;
        while (id < n && isIdentPart(src.charAt(id))) id++;
        var word = src.slice(i, id);

        // 9. 'use' statement: special-cased to handle alias + dotted path.
        if (word === "use") {
          out += span("kw", "use");
          i = id;
          i = emitUse(src, i, n, function (frag) { out += frag; });
          prevKw = "use";
          continue;
        }

        var cls = classifyIdent(word, src, id, n, prevKw);
        out += span(cls, word);
        prevKw = cls === "kw" ? word : null;
        i = id;
        continue;
      }

      // 11. any other char (operators/punctuation): emit escaped, plain.
      out += esc(c);
      prevKw = null;
      i++;
    }

    return out;
  }

  // classifies a plain identifier per the ordered rules.
  function classifyIdent(word, src, after, n, prevKw) {
    // a. keyword.
    if (KEYWORDS[word]) return "kw";
    // b. function name following 'fun'.
    if (prevKw === "fun") return "fn";
    var nextIdx = skipSpaces(src, after);
    var next = nextIdx < n ? src.charAt(nextIdx) : "";
    // c. typed declaration (param/local).
    if (next === ":") return "param";
    // d. primitive or capitalized type.
    if (PRIMITIVES[word] || isUpper(word.charAt(0))) return "type";
    // e. call.
    if (next === "(" || next === "[") return "fn";
    // f. plain.
    return null;
  }

  // renders a decorator run: string literals -> str, everything else -> deco.
  function emitDecorator(run) {
    var out = "";
    var i = 0;
    var n = run.length;
    var chunk = "";
    while (i < n) {
      if (run.charAt(i) === '"') {
        if (chunk) { out += span("deco", chunk); chunk = ""; }
        var s = i + 1;
        while (s < n && run.charAt(s) !== '"') {
          if (run.charAt(s) === "\\") s++;
          s++;
        }
        if (s < n) s++; // closing quote
        out += span("str", run.slice(i, s));
        i = s;
      } else {
        chunk += run.charAt(i);
        i++;
      }
    }
    if (chunk) out += span("deco", chunk);
    return out;
  }

  // renders a 'use' statement body (after the 'use' keyword) up to and
  // including the trailing ';'. emit() receives ready-to-append HTML.
  // returns the index just past the ';'.
  function emitUse(src, i, n, emit) {
    // leading whitespace before the first identifier.
    var ws = i;
    i = skipSpaces(src, i);
    if (i > ws) emit(esc(src.slice(ws, i)));

    if (i >= n || !isIdentStart(src.charAt(i))) return i;

    // read the first identifier.
    var idEnd = i;
    while (idEnd < n && isIdentPart(src.charAt(idEnd))) idEnd++;
    var first = src.slice(i, idEnd);

    // peek the next non-space char.
    var afterIdx = skipSpaces(src, idEnd);
    var isAlias = afterIdx < n && src.charAt(afterIdx) === ":";

    if (isAlias) {
      emit(span("alias", first));
      // whitespace between alias and ':'.
      if (afterIdx > idEnd) emit(esc(src.slice(idEnd, afterIdx)));
      emit(esc(":")); // ':' plain
      i = afterIdx + 1;
    }
    // when not aliased, i remains at the first identifier and the whole
    // dotted path (starting there) becomes the mod run below.

    // dotted path: everything up to ';' is class mod (interior whitespace verbatim).
    var pathStart = i;
    while (i < n && src.charAt(i) !== ";") i++;
    var path = src.slice(pathStart, i);
    // split leading whitespace out of the mod span so it stays plain.
    var lead = 0;
    while (lead < path.length && isSpace(path.charAt(lead))) lead++;
    if (lead) emit(esc(path.slice(0, lead)));
    var body = path.slice(lead);
    // and trailing whitespace before ';'.
    var trail = body.length;
    while (trail > 0 && isSpace(body.charAt(trail - 1))) trail--;
    if (body.slice(0, trail)) emit(span("mod", body.slice(0, trail)));
    if (body.slice(trail)) emit(esc(body.slice(trail)));

    if (i < n && src.charAt(i) === ";") {
      emit(esc(";")); // trailing ';' plain
      i++;
    }
    return i;
  }

  // browser loader: highlight every [data-src] element on load.
  function load() {
    var els = document.querySelectorAll("[data-src]");
    Array.prototype.forEach.call(els, function (el) {
      fetch(el.dataset.src)
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        })
        .then(function (text) {
          el.innerHTML = tokenize(text);
        })
        .catch(function (err) {
          // leave existing fallback content in place.
          console.warn("highlight: failed to load " + el.dataset.src, err);
        });
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { tokenize: tokenize };
  } else if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", load);
    } else {
      load();
    }
  }
})();
