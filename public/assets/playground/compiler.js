// the mach compiler, as a service: mach.wasm over an in-memory project at /.
// the libraries sit under /dep, the session's sources under /src, and the
// manifest is written from the session's target on every request. as a worker
// it answers one request at a time, and under node the same engine is driven
// directly.
(function () {
  "use strict";

  const node = typeof module !== "undefined" && module.exports;
  if (!node) { importScripts("wasi.js", "project.js"); }
  const wasi = node ? require("./wasi.js") : self.machWasi;
  const project = node ? require("./project.js") : self.machProject;

  const LISTING_SUFFIX = { asm: ".s", ir: ".ir", "ir-opt": ".ir" };

  // loader: { module(onProgress) -> WebAssembly.Module, libs() -> { name: { path: text } } }
  function createCompiler(loader) {
    const fs = wasi.makeFs();
    let compiler = null;
    let info = null;

    // one compiler invocation over the project, its two streams interleaved
    // as written
    async function mach(argv, stdin) {
      const dec = new TextDecoder();
      let out = "";
      const ran = await wasi.runWasi(compiler, {
        argv: ["mach"].concat(argv),
        stdin: stdin || "",
        fs,
        onOutput: (_fd, bytes) => { out += dec.decode(bytes, { stream: true }); },
      });
      return { out: out + dec.decode(), exitCode: ran.exitCode, trap: ran.trap, ms: ran.ms };
    }

    // loads the compiler and the libraries once, and reads from the compiler
    // itself what it is and what it can build for
    async function init(onProgress) {
      if (info) { return info; }
      const loaded = await Promise.all([loader.module(onProgress || (() => {})), loader.libs()]);
      compiler = loaded[0];
      const libs = {};
      // std first, then the rest by name
      for (const name of Object.keys(loaded[1]).sort((a, b) => (a === "std" ? -1 : b === "std" ? 1 : a.localeCompare(b)))) {
        const files = loaded[1][name];
        for (const path of Object.keys(files)) { fs.write("/dep/" + name + "/" + path, files[path]); }
        const version = /^version\s*=\s*"([^"]*)"/m.exec(files["mach.toml"] || "");
        libs[name] = {
          version: version ? version[1] : "",
          files: Object.keys(files).filter((p) => p.startsWith("src/")).map((p) => p.slice(4)).sort(),
        };
      }
      const about = await mach(["info", "--report", "json"]);
      const catalog = await mach(["info", "targets", "--report", "json"]);
      const host = project.parseRecords(about.out).host;
      const targets = project.parseRecords(catalog.out).targets;
      if (about.trap || catalog.trap || !host || !targets.length) {
        throw new Error("the compiler did not start: " + (about.trap || catalog.trap || (about.out + catalog.out).trim()));
      }
      info = { version: host.mach, targets: project.targetRows(targets), libs };
      return info;
    }

    // makes /mach.toml and /src match a session: its files written, every
    // other source removed
    function sync(req) {
      fs.write("/mach.toml", project.manifest(info.targets, req.settings));
      const kept = new Set();
      for (const name of Object.keys(req.files)) {
        if (!project.validFileName(name)) { continue; }
        kept.add(name);
        fs.write("/src/" + name, req.files[name]);
      }
      for (const name of fs.files("/src")) {
        if (!kept.has(name)) { fs.remove("/src/" + name); }
      }
    }

    // the source line a span starts on, so a diagnostic stands alone
    function excerpt(span) {
      if (!span || !span.file) { return span; }
      const text = fs.readText("/" + span.file);
      const line = text === null ? null : text.split("\n")[span.line - 1];
      return Object.assign({}, span, { text: line === undefined ? null : line });
    }

    function report(ran) {
      const records = project.parseRecords(ran.out);
      const diagnostics = records.diagnostics.map((d) => Object.assign({}, d, {
        primary: excerpt(d.primary),
        related: (d.related || []).map(excerpt),
      }));
      const ok = !ran.trap && ran.exitCode === 0 && Boolean(records.summary) && records.summary.outcome === "success";
      return {
        ok,
        diagnostics,
        phases: records.phases,
        summary: records.summary,
        stray: records.stray.join("\n"),
        trap: ran.trap,
        ms: ran.ms,
      };
    }

    async function check(req) {
      await init();
      sync(req);
      const argv = project.command(req.settings, "check");
      return Object.assign(report(await mach(argv.concat(["--report", "json"]))), { command: argv });
    }

    // the project's own modules of one emitted listing kind, entry first
    function listings(req, kind) {
      const dir = "/" + project.workDir(req.settings) + "/" + kind + "/" + project.PROJECT_ID;
      const suffix = LISTING_SUFFIX[kind];
      const entry = project.ENTRY.replace(/\.mach$/, suffix);
      return fs.files(dir)
        .filter((p) => p.endsWith(suffix))
        .sort((a, b) => (a === entry ? -1 : b === entry ? 1 : a.localeCompare(b)))
        .map((p) => ({ file: p.slice(0, -suffix.length) + ".mach", text: fs.readText(dir + "/" + p) }));
    }

    async function build(req) {
      await init();
      sync(req);
      // listings are read back by directory, so the last build's go first. the
      // objects stay, for the compiler's own cache
      for (const kind of Object.keys(LISTING_SUFFIX)) { fs.remove("/" + project.workDir(req.settings) + "/" + kind); }
      const argv = project.command(req.settings, "build");
      const out = Object.assign(report(await mach(argv.concat(["--report", "json", "-v"]))), {
        command: argv,
        artifact: null,
        asm: [],
        ir: [],
      });
      if (!out.ok) { return out; }
      const kinds = project.emits(req.settings);
      if (kinds.indexOf("exe") !== -1) {
        const built = out.summary.built && out.summary.built[0];
        out.artifact = built && built.out ? fs.read("/" + built.out) : null;
      }
      if (kinds.indexOf("asm") !== -1) { out.asm = listings(req, "asm"); }
      out.ir = listings(req, kinds.indexOf("ir-opt") !== -1 ? "ir-opt" : "ir");
      return out;
    }

    // formats one source text, through the compiler's stdin and stdout
    async function format(req) {
      await init();
      const dec = new TextDecoder();
      const streams = { 1: "", 2: "" };
      const ran = await wasi.runWasi(compiler, {
        argv: ["mach", "fmt", "-"],
        stdin: req.source,
        fs: wasi.makeFs(),
        onOutput: (fd, bytes) => { streams[fd] += dec.decode(bytes); },
      });
      const ok = !ran.trap && ran.exitCode === 0;
      return { ok, source: ok ? streams[1] : null, message: ok ? "" : (ran.trap || streams[2].trim()) };
    }

    // a library file, by its path under dep/
    async function readLib(req) {
      await init();
      const clean = wasi.cleanPath(req.path);
      return { path: clean.slice(1), text: clean.startsWith("/dep/") ? fs.readText(clean) : null };
    }

    return { init, check, build, format, readLib };
  }

  if (node) {
    module.exports = { createCompiler };
    return;
  }

  // the module compiled as it streams in, its decoded bytes counted for the
  // progress line
  async function fetchModule(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) { throw new Error("could not load " + url + " (HTTP " + res.status + ")"); }
    let loaded = 0;
    const counted = res.body.pipeThrough(new TransformStream({
      transform(chunk, ctl) {
        loaded += chunk.length;
        onProgress(loaded);
        ctl.enqueue(chunk);
      },
    }));
    return WebAssembly.compileStreaming(new Response(counted, { headers: { "content-type": "application/wasm" } }));
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) { throw new Error("could not load " + url + " (HTTP " + res.status + ")"); }
    return res.json();
  }

  const compiler = createCompiler({
    module: (onProgress) => fetchModule("/playground/mach.wasm", onProgress),
    libs: () => fetchJson("/playground/libs.json"),
  });

  // requests are { id, op, ... }, answered in order with { id, result } or
  // { id, error }. init also posts { id, progress } as the compiler loads
  const OPS = ["init", "check", "build", "format", "readLib"];
  let queue = Promise.resolve();
  self.onmessage = (ev) => {
    const req = ev.data;
    queue = queue.then(async () => {
      try {
        if (OPS.indexOf(req.op) === -1) { throw new Error("unknown request: " + req.op); }
        const result = req.op === "init"
          ? await compiler.init((loaded) => self.postMessage({ id: req.id, progress: loaded }))
          : await compiler[req.op](req);
        const transfer = result && result.artifact ? [result.artifact.buffer] : [];
        self.postMessage({ id: req.id, result }, transfer);
      } catch (err) {
        self.postMessage({ id: req.id, error: err && err.message ? err.message : String(err) });
      }
    });
  };
})();
