// the playground page: a session (files, target, arguments) edited on the
// left, and what the compiler makes of it on the right. the compiler lives in
// one worker and a running program in another, so neither can hang the page.
(function () {
  "use strict";

  const project = self.machProject;
  const examples = self.machExamples;
  const spirv = self.machSpirv;
  const $ = (id) => document.getElementById(id);

  const STORE_SESSION = "mach.playground.session";
  const STORE_SPLIT = "mach.playground.split";
  const DEFAULT_EXAMPLE = "comptime";
  const COMPILER_TIMEOUT_MS = 120000;
  const RUN_TIMEOUT_MS = 10000;
  const LIVE_DELAY_MS = 350;

  // the result views a target has, by how the browser can execute it
  const TABS = {
    program: ["output", "ir", "build"],
    shader: ["preview", "spirv", "ir", "build"],
    none: ["asm", "ir", "build"],
  };
  const TAB_LABEL = { output: "output", preview: "preview", spirv: "spir-v", asm: "asm", ir: "ir", build: "build" };
  const TAB_VIEW = { output: "output", preview: "preview", spirv: "listing", asm: "listing", ir: "listing", build: "build" };

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const key of Object.keys(props || {})) {
      if (props[key] === null || props[key] === undefined) { continue; }
      if (key === "class") { node.className = props[key]; }
      else if (key === "text") { node.textContent = props[key]; }
      else if (key.startsWith("on")) { node.addEventListener(key.slice(2), props[key]); }
      else { node.setAttribute(key, props[key]); }
    }
    for (const child of children || []) { node.append(child); }
    return node;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (_e) { /* storage is optional */ }
  }

  function stored(key) {
    try { return localStorage.getItem(key); } catch (_e) { return null; }
  }

  // ---- state ----

  const state = {
    info: null,          // what the compiler reported of itself, once loaded
    files: {},           // the session's sources, by path under src/
    active: project.ENTRY,
    peek: null,          // a library file open read-only: { path, text }
    target: Object.assign({}, project.DEFAULT_TARGET),
    optimize: true,
    args: "",
    example: null,
    dirty: false,        // edited since it was loaded
    version: 0,          // counts every change a build would see
    tab: null,
    report: null,        // the compiler's latest answer, a check or a build
    built: null,         // the latest build that succeeded
    shader: null,        // that build's module, read: { bytes, listing, note }
    run: null,           // the latest run: { exit }
    busy: "",            // what the compiler or the program is doing, for the status line
    libsOpen: false,
    directives: false,   // whether an assembly listing keeps its directives
    split: Number(stored(STORE_SPLIT)) || 0.5,
  };

  const settings = () => ({ target: state.target, optimize: state.optimize });
  const execution = () => project.execution(state.target) || "none";
  const session = () => ({
    files: state.files, active: state.active, target: state.target,
    optimize: state.optimize, args: state.args, example: state.example,
  });

  // ---- the compiler worker ----

  // one request at a time reaches the worker, and a request it never answers
  // costs the worker, not the page
  const client = (function () {
    let worker = null;
    let seq = 0;
    const waiting = new Map();

    function fail(message) {
      for (const job of waiting.values()) {
        clearTimeout(job.timer);
        job.reject(new Error(message));
      }
      waiting.clear();
      if (worker) { worker.terminate(); }
      worker = null;
    }

    function spawn() {
      worker = new Worker("/assets/playground/compiler.js");
      worker.onmessage = (ev) => {
        const job = waiting.get(ev.data.id);
        if (!job) { return; }
        if (ev.data.progress !== undefined) { job.onProgress(ev.data.progress); return; }
        clearTimeout(job.timer);
        waiting.delete(ev.data.id);
        if (ev.data.error !== undefined) { job.reject(new Error(ev.data.error)); } else { job.resolve(ev.data.result); }
      };
      worker.onerror = (ev) => fail(ev.message || "the compiler worker failed");
    }

    function call(op, payload, onProgress) {
      if (!worker) { spawn(); }
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail("the compiler stopped answering, and was restarted"), COMPILER_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer, onProgress: onProgress || (() => {}) });
        worker.postMessage(Object.assign({ id, op }, payload || {}));
      });
    }

    return { call };
  })();

  // ---- compiler work ----
  //
  // work is wanted, not started: one job runs at a time, and a newer want
  // replaces an older one that has not begun. a build outranks a live pass

  let working = false;
  let wanted = null;
  let liveTimer = 0;

  function want(kind) {
    if (kind === "build" || wanted !== "build") { wanted = kind; }
    pump();
  }

  // a live pass a moment after the last change, so typing does not queue one
  // per key
  function wantLive() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => want("live"), LIVE_DELAY_MS);
  }

  async function pump() {
    if (working || !wanted || !state.info) { return; }
    const kind = wanted;
    wanted = null;
    working = true;
    try {
      // a shader builds in milliseconds, so its live pass is a whole build
      if (kind === "build" || execution() === "shader") { await build(kind === "build"); } else { await check(); }
    } catch (err) {
      state.report = { ok: false, version: state.version, failure: err.message, diagnostics: [], phases: [], command: [] };
      if (kind === "build") { state.tab = "build"; }
    }
    working = false;
    setBusy(runner ? "running" : "");
    render();
    pump();
  }

  const snapshot = () => ({ files: Object.assign({}, state.files), settings: settings() });

  async function check() {
    const version = state.version;
    setBusy("checking");
    state.report = Object.assign(await client.call("check", snapshot()), { version, verb: "check" });
  }

  // `explicit` is a build the user asked for: it runs the program, restarts
  // the shader's clock and brings the result into view
  async function build(explicit) {
    const version = state.version;
    const mode = execution();
    setBusy("building for " + project.targetName(state.target));
    const result = Object.assign(await client.call("build", snapshot()), { version, verb: "build", mode });
    state.report = result;
    if (!result.ok) {
      if (explicit) { state.tab = "build"; }
      return;
    }
    state.built = result;
    if (mode === "shader") {
      loadShader(result.artifact, explicit);
    } else if (mode === "program" && explicit) {
      run(result.artifact);
    }
    if (explicit) { state.tab = TABS[mode][0]; }
  }

  // ---- running a program ----

  let runner = null;
  let runTimer = 0;
  let outputParts = [];
  let outputFrame = 0;

  // writes arrive one message each, and reach the page once a frame
  function flushOutput() {
    cancelAnimationFrame(outputFrame);
    outputFrame = 0;
    const out = $("pg-stdout");
    const pinned = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
    for (const part of outputParts) { out.append(part.cls ? el("span", { class: part.cls, text: part.text }) : part.text); }
    outputParts = [];
    if (pinned) { out.scrollTop = out.scrollHeight; }
  }

  function appendOutput(cls, text) {
    const last = outputParts[outputParts.length - 1];
    if (last && last.cls === cls) { last.text += text; } else { outputParts.push({ cls, text }); }
    if (!outputFrame) { outputFrame = requestAnimationFrame(flushOutput); }
  }

  function endRun(exit) {
    clearTimeout(runTimer);
    if (runner) { runner.terminate(); }
    runner = null;
    flushOutput();
    state.run = { exit };
    const note = exit.stopped ? "stopped"
      : exit.timeout ? "stopped: still running after " + RUN_TIMEOUT_MS / 1000 + " seconds"
      : exit.truncated ? "stopped: more than 1 MiB of output"
      : exit.trap ? "trapped: " + exit.trap
      : null;
    // a program that ends having written nothing still says how it ended
    if (!note && !$("pg-stdout").textContent) { appendOutput("is-meta", "[exited with status " + exit.exitCode + " and wrote nothing]\n"); }
    if (note) {
      appendOutput("is-meta", ($("pg-stdout").textContent.endsWith("\n") || !$("pg-stdout").textContent ? "" : "\n") + "[" + note + "]\n");
    }
    flushOutput();
    setBusy("");
    render();
  }

  function run(wasm) {
    if (runner) { endRun({ stopped: true }); }
    $("pg-stdout").textContent = "";
    state.run = { exit: null };
    runner = new Worker("/assets/playground/runner.js");
    runner.onmessage = (ev) => {
      if (ev.data.exit) { endRun(ev.data.exit); } else { appendOutput(ev.data.fd === 2 ? "is-err" : "", ev.data.text); }
    };
    runner.onerror = (ev) => endRun({ trap: ev.message || "the runner failed" });
    runTimer = setTimeout(() => endRun({ timeout: true }), RUN_TIMEOUT_MS);
    runner.postMessage({ wasm, args: state.args }, [wasm.buffer]);
    setBusy("running");
  }

  // ---- drawing a shader ----

  const preview = self.machPreview.createPreview($("pg-canvas"), (stats) => {
    $("pg-preview-stats").textContent = stats.width + " × " + stats.height + " · " + stats.fps + " fps";
  });

  function loadShader(bytes, restart) {
    const listing = spirv.disassemble(bytes);
    const translated = spirv.toGlsl(bytes);
    const drawn = translated.ok ? preview.load(translated) : { ok: false, reason: "the preview cannot draw this module: it uses " + translated.reason };
    if (!drawn.ok) { preview.unload(); }
    if (restart) { preview.restart(); }
    state.shader = { bytes, listing, note: drawn.ok ? null : drawn.reason };
  }

  // ---- the session ----

  let saveTimer = 0;

  // keeps the session for the next visit, a moment after it settles
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store(STORE_SESSION, JSON.stringify(session())), 400);
  }

  // every change a build would see comes through here
  function changed(edited) {
    state.version++;
    if (edited) { state.dirty = true; }
    // the address names what was loaded, a link or an example, and edited code
    // is neither: a reload then opens the kept session, not the original
    if (location.hash || (edited && location.search)) { history.replaceState(null, "", location.pathname + (edited ? "" : location.search)); }
    save();
  }

  function adopt(next) {
    if (runner) { endRun({ stopped: true }); }
    state.files = next.files;
    state.active = next.active;
    state.peek = null;
    state.target = state.info ? project.resolveTarget(state.info.targets, next.target) : next.target;
    state.optimize = next.optimize;
    state.args = next.args;
    state.example = next.example;
    state.dirty = false;
    state.report = null;
    state.built = null;
    state.shader = null;
    state.run = null;
    state.tab = null;
    preview.unload();
    $("pg-stdout").textContent = "";
    $("pg-args").value = state.args;
    changed(false);
    showBuffer();
    renderFiles();
    renderTarget();
    render();
    want("build");
  }

  async function fetchExample(example) {
    const files = {};
    await Promise.all(Object.keys(example.files).map(async (name) => {
      const res = await fetch(example.files[name]);
      if (!res.ok) { throw new Error("could not load " + example.files[name]); }
      files[name] = await res.text();
    }));
    return files;
  }

  async function loadExample(id) {
    const example = examples.find((e) => e.id === id) || examples.find((e) => e.id === DEFAULT_EXAMPLE);
    setBusy("loading " + example.title);
    const files = await fetchExample(example).finally(() => setBusy(""));
    // a shader needs its target. a program keeps the one in use, unless that
    // one only builds shaders
    const shaderNow = project.execution(state.target) === "shader";
    const target = example.kind === "shader" ? project.SHADER_TARGET
      : shaderNow ? project.DEFAULT_TARGET
      : state.target;
    history.replaceState(null, "", location.pathname + "?example=" + example.id);
    adopt({ files, active: project.ENTRY, target, optimize: state.optimize, args: example.args || "", example: example.id });
  }

  // ---- the editor ----

  const source = $("pg-source");
  const shown = () => (state.peek ? state.peek.text : state.files[state.active] || "");
  const shownPath = () => (state.peek ? state.peek.path : "src/" + state.active);

  function highlight() {
    const text = source.value;
    const hl = self.machHighlight;
    // a trailing newline needs something after it to give the last line height
    $("pg-highlight").innerHTML = (hl ? hl.tokenize(text) : esc(text)) + (text.endsWith("\n") ? " " : "");
    renderGutter();
  }

  // line numbers, marked where the latest report has something to say
  function renderGutter() {
    const lines = source.value.split("\n").length;
    const marks = new Map();
    for (const d of (state.report && state.report.diagnostics) || []) {
      if (!d.primary || d.primary.file !== shownPath() || d.severity === "note") { continue; }
      const old = marks.get(d.primary.line);
      if (!old || d.severity === "error") { marks.set(d.primary.line, { severity: d.severity, message: (old ? old.message + "\n" : "") + d.message }); }
    }
    const gutter = $("pg-gutter");
    const rows = [];
    for (let i = 1; i <= lines; i++) {
      const mark = marks.get(i);
      rows.push(el("div", { class: mark ? "is-" + mark.severity : null, title: mark ? mark.message : null, text: String(i) }));
    }
    gutter.replaceChildren(...rows);
  }

  // the source is the one scroller. the highlighted layer and the line
  // numbers are moved by its offset, so neither has a scroll range of its own
  // to stop short of the source's
  function syncScroll() {
    $("pg-highlight").style.transform = "translate(" + -source.scrollLeft + "px, " + -source.scrollTop + "px)";
    $("pg-gutter").style.transform = "translateY(" + -source.scrollTop + "px)";
  }

  function showCursor() {
    const before = source.value.slice(0, source.selectionStart).split("\n");
    $("pg-status-cursor").textContent = "ln " + before.length + ", col " + (before[before.length - 1].length + 1);
  }

  // puts the active file, or the library file open over it, in the editor
  function showBuffer() {
    source.value = shown();
    source.readOnly = Boolean(state.peek);
    source.setSelectionRange(0, 0);
    source.scrollTop = 0;
    source.scrollLeft = 0;
    syncScroll();
    highlight();
    syncScroll();
    showCursor();
  }

  // replaces the selection as typing would, so the edit can be undone
  function type(text) {
    if (!document.execCommand("insertText", false, text)) {
      source.setRangeText(text, source.selectionStart, source.selectionEnd, "end");
      source.dispatchEvent(new Event("input"));
    }
  }

  // indents or outdents every line the selection touches
  function shiftLines(outdent) {
    const text = source.value;
    const from = text.lastIndexOf("\n", source.selectionStart - 1) + 1;
    const to = source.selectionEnd;
    const next = text.slice(from, to).split("\n").map((l) => (outdent ? l.replace(/^ {1,4}/, "") : "    " + l)).join("\n");
    source.setSelectionRange(from, to);
    type(next);
    source.setSelectionRange(from, from + next.length);
  }

  function onKey(ev) {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key === "Enter") { ev.preventDefault(); primary(); return; }
    if (mod && ev.key.toLowerCase() === "s") { ev.preventDefault(); format(); return; }
    if (source.readOnly) { return; }
    if (ev.key === "Tab" && !mod && !ev.altKey) {
      ev.preventDefault();
      if (ev.shiftKey || source.selectionStart !== source.selectionEnd) { shiftLines(ev.shiftKey); } else { type("    "); }
    } else if (ev.key === "Enter" && !mod && !ev.shiftKey) {
      // a new line keeps the indent of the one before, one level deeper after `{`
      const before = source.value.slice(source.value.lastIndexOf("\n", source.selectionStart - 1) + 1, source.selectionStart);
      ev.preventDefault();
      type("\n" + /^[ \t]*/.exec(before)[0] + (/\{\s*$/.test(before) ? "    " : ""));
    } else if (ev.key === "}" && /^[ \t]*$/.test(source.value.slice(source.value.lastIndexOf("\n", source.selectionStart - 1) + 1, source.selectionStart))) {
      // a closing brace on a blank line steps back out one level
      const lineStart = source.value.lastIndexOf("\n", source.selectionStart - 1) + 1;
      const indent = source.selectionStart - lineStart;
      ev.preventDefault();
      source.setSelectionRange(source.selectionStart - Math.min(4, indent), source.selectionEnd);
      type("}");
    }
  }

  function onInput() {
    if (state.peek) { return; }
    state.files[state.active] = source.value;
    changed(true);
    highlight();
    showCursor();
    renderStale();
    wantLive();
  }

  // opens a project file, or with `peek` a library file read-only over it
  function open(name, peek) {
    state.peek = peek || null;
    if (!peek) { state.active = name; }
    showBuffer();
    renderFiles();
    renderLibsCurrent();
    renderListing();
    save();
  }

  // selects a span in whichever file holds it
  async function reveal(span) {
    if (span.file === "mach.toml") {
      state.tab = "build";
      render();
      document.querySelector(".pg-manifest").open = true;
      document.querySelector(".pg-manifest").scrollIntoView({ block: "nearest" });
      return;
    }
    if (span.file.startsWith("src/") && state.files[span.file.slice(4)] !== undefined) {
      open(span.file.slice(4));
    } else {
      const lib = await client.call("readLib", { path: span.file });
      if (lib.text === null) { return; }
      open(null, lib);
    }
    const lines = source.value.split("\n");
    const offset = (line, column) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
    source.focus();
    source.setSelectionRange(offset(span.line, span.column), offset(span.end_line || span.line, span.end_column || span.column));
    const row = parseFloat(getComputedStyle(source).lineHeight) || 22;
    source.scrollTop = Math.max(0, (span.line - 6) * row);
    syncScroll();
    showCursor();
  }

  async function format() {
    if (state.peek || !state.info || !source.value.trim()) { return; }
    setBusy("formatting");
    let result = null;
    try {
      result = await client.call("format", { source: source.value });
    } catch (err) {
      result = { ok: false, message: err.message };
    }
    setBusy("");
    if (!result.ok) {
      flash("format failed: " + (result.message.split("\n")[0] || "the source does not parse"));
    } else if (result.source !== source.value) {
      const at = source.selectionStart;
      source.focus();
      source.select();
      type(result.source);
      source.setSelectionRange(Math.min(at, result.source.length), Math.min(at, result.source.length));
    }
  }

  // applies a fix the compiler offered: byte ranges replaced, last range first
  function applyFix(fix) {
    const enc = new TextEncoder();
    const byFile = new Map();
    for (const edit of fix.edits) {
      const name = edit.file.startsWith("src/") ? edit.file.slice(4) : null;
      if (name === null || state.files[name] === undefined) { return; }
      if (!byFile.has(name)) { byFile.set(name, []); }
      byFile.get(name).push(edit);
    }
    for (const [name, edits] of byFile) {
      let bytes = enc.encode(state.files[name]);
      for (const edit of edits.sort((a, b) => b.byte_start - a.byte_start)) {
        const insert = enc.encode(edit.replacement);
        const next = new Uint8Array(bytes.length - (edit.byte_end - edit.byte_start) + insert.length);
        next.set(bytes.subarray(0, edit.byte_start));
        next.set(insert, edit.byte_start);
        next.set(bytes.subarray(edit.byte_end), edit.byte_start + insert.length);
        bytes = next;
      }
      state.files[name] = new TextDecoder().decode(bytes);
    }
    changed(true);
    showBuffer();
    renderStale();
    want("live");
  }

  // ---- file tabs ----

  const fileNames = () => Object.keys(state.files).sort((a, b) => (a === project.ENTRY ? -1 : b === project.ENTRY ? 1 : a.localeCompare(b)));

  // an inline name field in the tab strip. `done` takes a valid, unused name
  function nameInput(initial, done) {
    const input = el("input", { class: "pg-tab-input", type: "text", value: initial, spellcheck: "false", "aria-label": "File name", placeholder: "name.mach" });
    const named = () => {
      const raw = input.value.trim().replace(/^src\//, "");
      return raw && !raw.endsWith(".mach") ? raw + ".mach" : raw;
    };
    const valid = () => project.validFileName(named()) && (named() === initial || state.files[named()] === undefined);
    input.addEventListener("input", () => input.classList.toggle("is-invalid", !valid()));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && valid()) { done(named()); }
      if (ev.key === "Escape") { renderFiles(); }
    });
    input.addEventListener("blur", () => renderFiles());
    return input;
  }

  function addFile() {
    const input = nameInput("", (name) => {
      state.files[name] = "";
      changed(true);
      open(name);
      source.focus();
    });
    $("pg-files").lastChild.replaceWith(input);
    input.focus();
  }

  function renameFile(name, tab) {
    const input = nameInput(name, (next) => {
      if (next !== name) {
        state.files[next] = state.files[name];
        delete state.files[name];
        changed(true);
        wantLive();
      }
      open(next);
    });
    tab.replaceWith(input);
    input.focus();
    input.setSelectionRange(0, name.length - ".mach".length);
  }

  function renderFiles() {
    const tabs = fileNames().map((name) => {
      const tab = el("button", {
        class: "pg-tab", type: "button", role: "tab", text: name,
        "aria-selected": String(!state.peek && state.active === name),
        title: project.moduleOf(name),
        // the open tab is left as it is, so a double click still lands on it
        onclick: () => { if (state.peek || state.active !== name) { open(name); } },
      });
      if (name !== project.ENTRY) {
        tab.addEventListener("dblclick", () => renameFile(name, tab));
        // the first click arms the delete and the second does it
        const x = el("span", { class: "pg-tab-x", role: "button", "aria-label": "Delete " + name, title: "Delete " + name, text: "×" });
        x.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (!x.classList.contains("is-armed")) {
            x.classList.add("is-armed");
            x.textContent = "delete?";
            return;
          }
          delete state.files[name];
          changed(true);
          open(state.active === name ? project.ENTRY : state.active);
          wantLive();
        });
        tab.append(x);
      }
      return tab;
    });
    if (state.peek) {
      const x = el("span", { class: "pg-tab-x", role: "button", "aria-label": "Close", text: "×" });
      x.addEventListener("click", (ev) => { ev.stopPropagation(); open(state.active); });
      tabs.push(el("button", { class: "pg-tab is-peek", type: "button", role: "tab", "aria-selected": "true", title: state.peek.path + ", read-only" }, [state.peek.path.replace(/^dep\//, "").replace("/src/", "/"), x]));
    }
    tabs.push(el("button", { class: "pg-tab", type: "button", title: "Add a file", "aria-label": "Add a file", text: "+", onclick: addFile }));
    $("pg-files").replaceChildren(...tabs);
    $("pg-format").disabled = Boolean(state.peek) || !state.info;
  }

  // ---- the library browser ----

  function libFile(lib, path) {
    const full = "dep/" + lib + "/src/" + path;
    return el("button", {
      class: "pg-lib-file", type: "button", text: path.split("/").pop(), title: full, "data-path": full,
      onclick: async () => {
        const file = await client.call("readLib", { path: full });
        if (file.text !== null) { open(null, file); }
      },
    });
  }

  // a library's files as nested folders, each a <details>
  function libTree(lib, files) {
    const root = { dirs: new Map(), files: [] };
    for (const path of files) {
      let at = root;
      const parts = path.split("/");
      for (const dir of parts.slice(0, -1)) {
        if (!at.dirs.has(dir)) { at.dirs.set(dir, { dirs: new Map(), files: [] }); }
        at = at.dirs.get(dir);
      }
      at.files.push(path);
    }
    const draw = (dir) => el("div", {}, Array.from(dir.dirs.keys()).sort()
      .map((name) => el("details", {}, [el("summary", { text: name + "/" }), draw(dir.dirs.get(name))]))
      .concat(dir.files.map((path) => libFile(lib, path))));
    return draw(root);
  }

  function renderLibs() {
    const tree = $("pg-libs-tree");
    if (!state.info) { tree.replaceChildren(el("p", { class: "pg-note", text: "the libraries arrive with the compiler" })); return; }
    const query = $("pg-libs-filter").value.trim().toLowerCase();
    const libs = Object.keys(state.info.libs);
    if (query) {
      const hits = [];
      for (const lib of libs) {
        for (const path of state.info.libs[lib].files) {
          if ((lib + "/" + path).toLowerCase().includes(query)) {
            const file = libFile(lib, path);
            file.textContent = lib + "/" + path;
            hits.push(file);
          }
        }
      }
      tree.replaceChildren(...(hits.length ? hits : [el("p", { class: "pg-note", text: "no file matches" })]));
    } else {
      tree.replaceChildren(...libs.map((lib) => el("details", { open: lib === "std" ? "" : null }, [
        el("summary", {}, [lib + " ", el("small", { text: state.info.libs[lib].version })]),
        libTree(lib, state.info.libs[lib].files),
      ])));
    }
    renderLibsCurrent();
  }

  function renderLibsCurrent() {
    for (const node of $("pg-libs-tree").querySelectorAll(".pg-lib-file")) {
      node.setAttribute("aria-current", String(Boolean(state.peek) && node.dataset.path === state.peek.path));
    }
  }

  // ---- layout ----

  function applyLayout() {
    $("pg-libs").hidden = !state.libsOpen;
    $("pg-libs-btn").setAttribute("aria-pressed", String(state.libsOpen));
    const left = Math.round(state.split * 1000);
    $("pg-work").style.gridTemplateColumns = (state.libsOpen ? "260px " : "") + "minmax(0, " + left + "fr) 12px minmax(0, " + (1000 - left) + "fr)";
  }

  function setSplit(fraction) {
    state.split = Math.min(0.8, Math.max(0.2, fraction));
    store(STORE_SPLIT, String(state.split));
    applyLayout();
  }

  function bindSplit() {
    const bar = $("pg-split");
    bar.addEventListener("pointerdown", (ev) => {
      bar.setPointerCapture(ev.pointerId);
      bar.classList.add("is-dragging");
    });
    bar.addEventListener("pointermove", (ev) => {
      if (!bar.classList.contains("is-dragging")) { return; }
      // the panes share what the library browser leaves of the row
      const first = bar.previousElementSibling.getBoundingClientRect();
      const last = bar.nextElementSibling.getBoundingClientRect();
      setSplit((ev.clientX - first.left) / (last.right - first.left));
    });
    const stop = () => bar.classList.remove("is-dragging");
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
    bar.addEventListener("dblclick", () => setSplit(0.5));
    bar.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft") { setSplit(state.split - 0.02); }
      if (ev.key === "ArrowRight") { setSplit(state.split + 0.02); }
    });
  }

  // ---- popovers ----

  const menus = [["pg-examples-btn", "pg-examples"], ["pg-target-btn", "pg-target"]];

  function setMenu(openId) {
    for (const [btn, pop] of menus) {
      $(pop).hidden = pop !== openId;
      $(btn).setAttribute("aria-expanded", String(pop === openId));
    }
    if (openId === "pg-examples") { renderExamples(); }
  }

  function bindMenus() {
    for (const [btn, pop] of menus) {
      $(btn).addEventListener("click", () => setMenu($(pop).hidden ? pop : null));
    }
    document.addEventListener("pointerdown", (ev) => {
      if (!ev.target.closest(".pg-menu")) { setMenu(null); }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { setMenu(null); }
    });
  }

  function renderExamples() {
    const group = (kind, name, note) => el("div", { class: "pg-group is-" + kind + "s" }, [
      el("div", { class: "pg-group-head" }, [el("span", { class: "pg-group-name", text: name }), el("span", { class: "pg-group-note", text: note })]),
    ].concat(examples.filter((e) => e.kind === kind).map((e) => {
      const blurb = el("small", { text: e.blurb });
      const item = el("button", { class: "pg-example", type: "button", "aria-current": String(state.example === e.id) }, [e.title, blurb]);
      item.addEventListener("click", () => {
        // edits are not thrown away on one click
        if (state.dirty && !item.classList.contains("is-confirm")) {
          item.classList.add("is-confirm");
          blurb.textContent = "this replaces your code. click again to load it";
          return;
        }
        setMenu(null);
        loadExample(e.id).catch((err) => flash(err.message));
      });
      return item;
    })));
    $("pg-examples").replaceChildren(
      group("program", "programs", "run on wasi-wasm32"),
      group("shader", "shaders", "drawn from vulkan-spirv"),
    );
  }

  let targetTimer = 0;

  function setAxis(key, value, settle) {
    if (state.target[key] === value) { return; }
    state.target = project.resolveTarget(state.info.targets, Object.assign({}, state.target, { [key]: value }), key);
    changed(false);
    // the result views belong to the target, so the first one it has opens
    if (TABS[execution()].indexOf(state.tab) === -1) { state.tab = null; }
    renderTarget(key);
    render();
    clearTimeout(targetTimer);
    targetTimer = setTimeout(() => want("build"), settle);
  }

  function renderTargetName() {
    $("pg-target-name").textContent = [project.targetName(state.target)].concat(state.info ? project.targetDetail(state.info.targets, state.target) : []).join(" · ");
    $("pg-target-btn").disabled = !state.info;
  }

  // the selector: every axis of the target, each with what the catalog offers
  // for the rest of the selection. `keep` names a text axis being typed in,
  // which is left alone so the caret stays put
  function renderTarget(keep) {
    renderTargetName();
    if (!state.info) { return; }
    const rows = [];
    const typing = keep && document.activeElement === $("pg-axis-" + keep) ? document.activeElement : null;
    for (const axis of project.AXES) {
      const choices = project.axisChoices(state.info.targets, axis.key, state.target);
      if (axis.kind === "free") {
        const old = $("pg-axis-" + axis.key);
        if (keep === axis.key && old) { rows.push(old.closest(".pg-axis")); continue; }
        const input = el("input", {
          id: "pg-axis-" + axis.key, type: "text", value: state.target[axis.key], spellcheck: "false", autocomplete: "off",
          list: "pg-axis-list-" + axis.key,
          placeholder: axis.key === "isa" ? (choices.required ? "required: an instruction set" : "the system's floor") : "extensions, comma separated",
        });
        input.addEventListener("input", () => setAxis(axis.key, input.value, 700));
        rows.push(el("div", { class: "pg-axis" }, [
          el("label", { class: "pg-axis-name", for: "pg-axis-" + axis.key, text: axis.label }),
          el("div", {}, [input, el("datalist", { id: "pg-axis-list-" + axis.key }, choices.suggestions.map((s) => el("option", { value: s })))]),
        ]));
        continue;
      }
      if (!choices.length) { continue; }
      rows.push(el("div", { class: "pg-axis" }, [
        el("span", { class: "pg-axis-name", text: axis.label }),
        el("div", { class: "pg-chips", role: "group", "aria-label": axis.label }, choices.map((c) => el("button", {
          class: "pg-chip-btn" + (c.available === false ? " is-off" : ""), type: "button", text: c.name,
          "aria-pressed": String(state.target[axis.key] === c.name),
          title: c.available === false ? "changes the " + (axis.key === "sys" ? "architecture" : "system") + " to one that has it" : null,
          onclick: () => setAxis(axis.key, c.name, 0),
        }))),
      ]));
    }
    const mode = execution();
    rows.push(el("p", { class: "pg-target-note" }, mode === "program" ? [el("b", { text: "runs here. " }), "a wasi module is a program the browser can run."]
      : mode === "shader" ? [el("b", { text: "draws here. " }), "a fragment stage is translated to WebGL2 for the preview."]
      : [el("b", { text: "builds here. " }), "the browser cannot run this target, so the result is its assembly and IR."]));
    $("pg-target").replaceChildren(...rows);
    if (typing) { typing.focus(); }
  }

  // ---- the result pane ----

  function counts() {
    const out = { error: 0, warning: 0 };
    for (const d of (state.report && state.report.diagnostics) || []) {
      if (out[d.severity] !== undefined) { out[d.severity]++; }
    }
    if (state.report && state.report.failure) { out.error++; }
    return out;
  }

  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

  function renderTabs() {
    const tabs = TABS[execution()];
    if (tabs.indexOf(state.tab) === -1) { state.tab = tabs[0]; }
    const n = counts();
    $("pg-tabs").replaceChildren(...tabs.map((tab) => {
      const node = el("button", {
        class: "pg-tab", type: "button", role: "tab", text: TAB_LABEL[tab], "aria-selected": String(state.tab === tab),
        onclick: () => { state.tab = tab; render(); },
      });
      if (tab === "build" && (n.error || n.warning)) {
        node.append(el("span", { class: "pg-tab-count" + (n.error ? "" : " is-warning"), text: String(n.error || n.warning) }));
      }
      return node;
    }));
  }

  // the view for the open tab, or a line saying why there is nothing in it yet
  function renderView() {
    let empty = null;
    if (!state.info && !state.report) {
      empty = state.busy || "starting the compiler";
    } else if (state.tab === "output" && !state.run) {
      empty = "press run, or ctrl+enter, to build and run the program";
    } else if (state.tab === "preview" && !state.shader) {
      empty = "the shader is drawn here once it builds";
    } else if (TAB_VIEW[state.tab] === "listing" && !listing()) {
      empty = state.tab === "spirv" ? "the module's SPIR-V is listed here once it builds"
        : state.built ? "this build wrote no " + TAB_LABEL[state.tab] + " for " + (state.peek ? "a library file" : state.active)
        : "press build, or ctrl+enter, to see the " + (state.tab === "asm" ? "assembly" : "IR");
    }
    for (const view of ["output", "preview", "listing", "build"]) {
      $("pg-view-" + view).hidden = empty !== null || TAB_VIEW[state.tab] !== view;
    }
    $("pg-empty").hidden = empty === null;
    $("pg-empty").textContent = empty || "";
    preview.setVisible(empty === null && state.tab === "preview");
    if (state.tab === "preview" && state.shader) {
      $("pg-canvas").hidden = Boolean(state.shader.note);
      $("pg-preview-note").hidden = !state.shader.note;
      $("pg-preview-note").textContent = state.shader.note || "";
      $("pg-pause").textContent = preview.paused ? "play" : "pause";
      $("pg-pause").disabled = $("pg-restart").disabled = Boolean(state.shader.note);
    }
  }

  // what the listing tab shows: { text, html, meta }, or null
  function listing() {
    if (state.tab === "spirv") {
      const s = state.shader;
      if (!s || !s.listing.ok) { return s ? { text: s.listing.error, html: esc(s.listing.error), meta: "" } : null; }
      const stages = s.listing.stages.map((x) => x.model + " " + x.name).join(", ");
      return { text: s.listing.text, html: highlightSpirv(s.listing.text), meta: "SPIR-V " + s.listing.version + " · " + stages + " · " + project.formatBytes(s.bytes.length) };
    }
    const list = state.built && state.built[state.tab];
    if (!list || !list.length) { return null; }
    // the listing follows the editor: the module of the file being edited
    const found = list.find((l) => l.file === state.active) || (list.length === 1 || state.peek ? list[0] : null);
    if (!found) { return null; }
    const text = state.tab === "asm" && !state.directives ? withoutDirectives(found.text) : found.text;
    const html = state.tab === "asm" ? highlightAsm(text) : (self.machHighlight ? self.machHighlight.tokenize(text) : esc(text));
    return { text, html, meta: project.moduleOf(found.file) + " · " + plural(text.split("\n").length - 1, "line") };
  }

  // an assembly listing as its labels and instructions: the directives that
  // only describe symbols, alignment and unwinding are dropped, and so are the
  // local labels nothing left in the listing refers to
  function withoutDirectives(text) {
    const kept = text.split("\n").filter((line) => !/^\s+\.(?!text\b|data\b|bss\b|rodata\b|section\b|ascii|asciz|string|byte\b|word\b|long\b|quad\b|zero\b)/.test(line));
    const used = new Set();
    for (const line of kept) {
      if (!/^[^\s:]+:/.test(line)) {
        for (const name of line.match(/\.L[A-Za-z0-9_.$]+/g) || []) { used.add(name); }
      }
    }
    return kept.filter((line) => {
      const label = /^(\.L[A-Za-z0-9_.$]+):/.exec(line);
      return !label || used.has(label[1]);
    }).join("\n");
  }

  function highlightAsm(text) {
    return text.split("\n").map((line) => {
      if (/^\s*(#|;|\/\/)/.test(line)) { return '<span class="cmt">' + esc(line) + "</span>"; }
      if (/^[^\s:]+:/.test(line)) { return '<span class="fn">' + esc(line) + "</span>"; }
      return esc(line).replace(/^(\s+)(\.[a-z_0-9]+)/, '$1<span class="deco">$2</span>').replace(/^(\s+)([a-z][a-z0-9.]*)(\s|$)/, '$1<span class="kw">$2</span>$3');
    }).join("\n");
  }

  function highlightSpirv(text) {
    return text.split("\n").map((line) => {
      if (line.startsWith(";")) { return '<span class="cmt">' + esc(line) + "</span>"; }
      return esc(line)
        .replace(/"(?:[^"\\]|\\.)*"/g, '<span class="str">$&</span>')
        .replace(/\bOp[A-Za-z0-9]+/g, '<span class="kw">$&</span>')
        .replace(/%[A-Za-z0-9_]+/g, '<span class="deco">$&</span>');
    }).join("\n");
  }

  let listed = null;

  function renderListing() {
    if (TAB_VIEW[state.tab] !== "listing") { return; }
    const found = listing();
    renderView();
    if (!found) {
      listed = null;
      $("pg-listing").textContent = "";
      return;
    }
    // the same text is not laid out again, which keeps its scroll position
    if (listed !== found.text) {
      $("pg-listing").innerHTML = found.html;
      $("pg-listing").scrollTop = 0;
      listed = found.text;
    }
    $("pg-listing-meta").textContent = found.meta;
    $("pg-download").hidden = state.tab !== "spirv";
    $("pg-directives").hidden = state.tab !== "asm";
    $("pg-directives").setAttribute("aria-pressed", String(state.directives));
  }

  function spanLine(span, label) {
    const where = span.file.replace(/^src\//, "") + ":" + span.line + ":" + span.column;
    const parts = [el("button", { class: "pg-span-at", type: "button", text: where, title: "Go to " + where, onclick: () => reveal(span) })];
    if (label) { parts.push(el("span", { class: "pg-span-label", text: "  " + label })); }
    if (span.text !== null && span.text !== undefined) {
      const pad = String(span.line).length;
      const width = span.end_line === span.line ? Math.max(1, span.end_column - span.column) : Math.max(1, span.text.length - span.column + 1);
      // the caret line keeps the source line's tabs, so the two stay aligned
      const lead = span.text.slice(0, span.column - 1).replace(/[^\t]/g, " ");
      parts.push(el("pre", {}, [span.line + " | " + span.text + "\n" + " ".repeat(pad) + " | " + lead, el("b", { text: "^".repeat(width) })]));
    }
    return el("div", { class: "pg-span" }, parts);
  }

  function renderBuild() {
    const report = state.report;
    $("pg-command").textContent = "mach " + project.command(settings(), report && report.verb === "check" ? "check" : "build").join(" ");
    $("pg-manifest").textContent = state.info ? project.manifest(state.info.targets, settings()) : "";
    const problems = [];
    if (report && report.failure) {
      problems.push(el("div", { class: "pg-problem" }, [el("div", { class: "pg-problem-head" }, [el("span", { class: "pg-severity", text: "error" }), el("span", { class: "pg-problem-text", text: report.failure })])]));
    }
    if (report && (report.trap || report.stray)) {
      problems.push(el("div", { class: "pg-problem" }, [el("div", { class: "pg-problem-head" }, [
        el("span", { class: "pg-severity", text: "error" }),
        el("span", { class: "pg-problem-key", text: "the compiler stopped" }),
        el("span", { class: "pg-problem-text", text: [report.trap, report.stray].filter(Boolean).join("\n") }),
      ])]));
    }
    for (const d of (report && report.diagnostics) || []) {
      const body = [el("div", { class: "pg-problem-head" }, [
        el("span", { class: "pg-severity is-" + d.severity, text: d.severity }),
        el("span", { class: "pg-problem-key", text: d.code }),
        el("span", { class: "pg-problem-text", text: d.message }),
      ])];
      if (d.primary) { body.push(spanLine(d.primary)); }
      for (const r of d.related || []) { body.push(spanLine(r, r.label)); }
      for (const note of d.notes || []) { body.push(el("div", { class: "pg-hint", "data-kind": "note", text: note })); }
      for (const help of d.help || []) { body.push(el("div", { class: "pg-hint", "data-kind": "help", text: help })); }
      for (const fix of d.fixes || []) {
        if (fix.edits.every((e) => e.file.startsWith("src/"))) {
          body.push(el("button", { class: "pg-tool", type: "button", text: "fix: " + fix.label, onclick: () => applyFix(fix) }));
        }
      }
      problems.push(el("div", { class: "pg-problem" }, body));
    }
    if (!problems.length) {
      problems.push(el("p", { class: "pg-note", text: !report ? "nothing has been checked yet" : report.verb === "check" ? "checked: no problems" : "built: no problems" }));
    }
    $("pg-problems").replaceChildren(...problems);
    // where a build's time went, the phases under codegen indented beneath it
    const phases = (report && report.phases) || [];
    $("pg-phases").hidden = !phases.length;
    const rows = phases.filter((p) => p.name !== "other" && p.name !== "target").map((p) => el("tr", { class: p.parent ? "is-child" : null }, [
      el("td", { text: p.name }),
      el("td", { text: project.formatDuration(p.time_us) }),
      el("td", { text: p.count !== undefined ? p.count + " " + p.unit : "" }),
    ]));
    const top = rows.filter((r) => !r.className);
    const children = rows.filter((r) => r.className);
    const codegen = top.findIndex((r) => r.firstChild.textContent === "codegen");
    if (codegen !== -1) { top.splice(codegen + 1, 0, ...children); }
    if (report && report.summary && report.summary.time_us) {
      top.push(el("tr", { class: "is-total" }, [el("td", { text: "total" }), el("td", { text: project.formatDuration(report.summary.time_us) }), el("td", {})]));
    }
    $("pg-phases").replaceChildren(...top);
  }

  // one chip for how the last build or run ended
  function renderOutcome() {
    const chip = $("pg-outcome");
    const n = counts();
    let text = "";
    let cls = "";
    if (state.report && !state.report.ok && state.report.verb === "build") {
      text = n.error ? plural(n.error, "error") : "build failed";
      cls = "is-fail";
    } else if (execution() === "program" && state.run) {
      const exit = state.run.exit;
      if (!exit) { text = "running"; }
      else if (exit.stopped || exit.timeout || exit.truncated) { text = "stopped"; cls = "is-fail"; }
      else if (exit.trap) { text = "trapped"; cls = "is-fail"; }
      else { text = "exit " + exit.exitCode + " · " + project.formatDuration(exit.ms * 1000); cls = exit.exitCode === 0 ? "is-ok" : "is-fail"; }
    } else if (state.built && state.built.mode === execution()) {
      const made = state.built.summary && state.built.summary.built && state.built.summary.built[0];
      text = (made && made.bytes ? project.formatBytes(made.bytes) + " · " : "") + project.formatDuration(state.built.ms * 1000);
    }
    chip.textContent = text;
    chip.className = "pg-chip" + (cls ? " " + cls : "");
  }

  function renderStale() {
    const basis = state.tab === "build" ? state.report : state.built;
    $("pg-stale").hidden = !basis || basis.version === state.version;
  }

  // ---- the bar and the status line ----

  let flashTimer = 0;

  function setBusy(text) {
    state.busy = text;
    renderStatus();
  }

  // a message that holds the status line for a moment
  function flash(text) {
    clearTimeout(flashTimer);
    $("pg-status-state").textContent = text;
    flashTimer = setTimeout(() => { flashTimer = 0; renderStatus(); }, 4000);
  }

  function renderStatus() {
    if (!flashTimer) { $("pg-status-state").textContent = state.busy || (state.info ? "ready" : "starting"); }
    const n = counts();
    const parts = [];
    if (n.error) { parts.push(plural(n.error, "error")); }
    if (n.warning) { parts.push(plural(n.warning, "warning")); }
    $("pg-status-problems").hidden = !parts.length;
    $("pg-status-problems").textContent = parts.join(", ");
    $("pg-status-toolchain").textContent = state.info
      ? ["mach " + state.info.version].concat(Object.keys(state.info.libs).map((l) => l + " " + state.info.libs[l].version)).join(" · ")
      : "";
    const running = Boolean(runner);
    $("pg-run-label").textContent = running ? "stop" : { program: "run", shader: "render", none: "build" }[execution()];
    $("pg-run-icon").setAttribute("href", running ? "#icon-stop" : "#icon-play");
    $("pg-run").disabled = !state.info;
  }

  function render() {
    renderTabs();
    renderView();
    renderListing();
    if (state.tab === "build") { renderBuild(); }
    renderOutcome();
    renderStale();
    renderStatus();
    renderGutter();
    renderTargetName();
    $("pg-optimize").setAttribute("aria-pressed", String(state.optimize));
  }

  // the bar's main button: stop what is running, or build and run
  function primary() {
    if (runner) { endRun({ stopped: true }); return; }
    clearTimeout(liveTimer);
    want("build");
  }

  async function share() {
    const fragment = "#code=" + await project.encodeShare(session());
    history.replaceState(null, "", location.pathname + fragment);
    try {
      await navigator.clipboard.writeText(location.href);
      flash("link copied to the clipboard");
    } catch (_e) {
      flash("the link is in the address bar");
    }
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    el("a", { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- start ----

  // the session to open with: a shared link, a named example, the last
  // session this browser kept, or the default example
  async function firstSession() {
    const shared = await project.decodeShare(location.hash);
    if (shared) { return shared; }
    const named = new URLSearchParams(location.search).get("example");
    let kept = null;
    try { kept = project.cleanSession(JSON.parse(stored(STORE_SESSION))); } catch (_e) { kept = null; }
    if (kept && !named) { return kept; }
    const example = examples.find((e) => e.id === named) || examples.find((e) => e.id === DEFAULT_EXAMPLE);
    return {
      files: await fetchExample(example), active: project.ENTRY, optimize: true, args: example.args || "", example: example.id,
      target: example.kind === "shader" ? project.SHADER_TARGET : project.DEFAULT_TARGET,
    };
  }

  function bind() {
    source.addEventListener("input", onInput);
    source.addEventListener("keydown", onKey);
    source.addEventListener("scroll", syncScroll);
    for (const type of ["click", "keyup", "select"]) { source.addEventListener(type, showCursor); }
    document.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter" && ev.target !== source) { ev.preventDefault(); primary(); }
    });
    $("pg-run").addEventListener("click", primary);
    $("pg-share").addEventListener("click", () => share().catch((err) => flash(err.message)));
    $("pg-format").addEventListener("click", format);
    $("pg-optimize").addEventListener("click", () => {
      state.optimize = !state.optimize;
      changed(false);
      render();
      want("build");
    });
    $("pg-args").addEventListener("input", () => { state.args = $("pg-args").value; save(); });
    $("pg-args").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { primary(); }
    });
    $("pg-libs-btn").addEventListener("click", () => { state.libsOpen = !state.libsOpen; applyLayout(); renderLibs(); });
    $("pg-libs-close").addEventListener("click", () => { state.libsOpen = false; applyLayout(); });
    $("pg-libs-filter").addEventListener("input", renderLibs);
    $("pg-pause").addEventListener("click", () => { preview.setPaused(!preview.paused); renderView(); });
    $("pg-restart").addEventListener("click", () => preview.restart());
    $("pg-copy").addEventListener("click", () => {
      const found = listing();
      if (found) { navigator.clipboard.writeText(found.text).then(() => flash("copied"), () => flash("could not reach the clipboard")); }
    });
    $("pg-directives").addEventListener("click", () => { state.directives = !state.directives; renderListing(); });
    $("pg-download").addEventListener("click", () => {
      if (state.shader) { download(state.shader.bytes, "shader.spv"); }
    });
    $("pg-status-problems").addEventListener("click", () => { state.tab = "build"; render(); });
    bindSplit();
    bindMenus();
  }

  async function start() {
    bind();
    applyLayout();
    renderTarget();
    render();
    // the code is on screen before the compiler is
    const opening = firstSession().then((first) => {
      Object.assign(state, first, { target: Object.assign({}, project.DEFAULT_TARGET, first.target) });
      $("pg-args").value = state.args;
      showBuffer();
      renderFiles();
      renderTarget();
      render();
    });
    setBusy("loading the compiler");
    try {
      const loaded = client.call("init", {}, (bytes) => setBusy("loading the compiler · " + (bytes / 1048576).toFixed(1) + " MB"));
      await opening;
      state.info = await loaded;
    } catch (err) {
      setBusy("the compiler did not load: " + err.message);
      return;
    }
    state.target = project.resolveTarget(state.info.targets, state.target);
    setBusy("");
    renderFiles();
    renderTarget();
    renderLibs();
    render();
    want("build");
  }

  start();
})();
