// what a playground project is, with no dom and no compiler in it: the target
// catalog and a selection within it, the manifest and command a selection
// builds with, the compiler's report records, and the share link codec.
(function () {
  "use strict";

  const PROJECT_ID = "play";
  const ENTRY = "main.mach";

  // the axes of a target, in the order a selector shows them. `row` axes take
  // their values from the catalog row the system and architecture pick, and
  // `free` axes are text the compiler alone validates
  const AXES = [
    { key: "sys", label: "system", kind: "grid" },
    { key: "arch", label: "architecture", kind: "grid" },
    { key: "env", label: "environment", kind: "row" },
    { key: "abi", label: "abi", kind: "row" },
    { key: "codeModel", label: "code model", kind: "row" },
    { key: "linkage", label: "linkage", kind: "row" },
    { key: "isa", label: "isa", kind: "free" },
    { key: "ext", label: "ext", kind: "free" },
  ];

  // instruction sets worth offering per architecture, the first one filling in
  // where a target must name one. suggestions only: any selection the
  // architecture's catalog spells is accepted
  const ISA_PRESETS = {
    x86_64: ["x86-64", "x86-64-v2", "x86-64-v3", "x86-64-v4"],
    aarch64: ["armv8-a+fp+simd", "armv8.2-a+fp+simd", "armv9-a+fp+simd"],
    riscv64: ["rv64gc", "rv64imac", "rv64i"],
    riscv32: ["rv32imac", "rv32gc", "rv32imc", "rv32i"],
    riscv32e: ["rv32e", "rv32emc"],
  };

  const DEFAULT_TARGET = { sys: "wasi", arch: "wasm32" };
  const SHADER_TARGET = { sys: "vulkan", arch: "spirv", env: "vulkan1.3" };

  // the catalog from the `target` records of `mach info targets`, one row per
  // <sys>-<arch>. an environment the system has no name for is "none"
  function targetRows(records) {
    const choice = (c) => ({ name: c.name === null ? "none" : c.name, isDefault: c.default });
    const rows = [];
    for (const rec of records) {
      const linkage = {};
      for (const env of rec.envs) { linkage[env.name === null ? "none" : env.name] = env.linkages.map(choice); }
      rows.push({
        name: rec.name,
        sys: rec.sys,
        arch: rec.arch,
        env: rec.envs.map(choice),
        abi: rec.abis.map(choice),
        codeModel: rec.code_models.map(choice),
        linkage,
        needsIsa: rec.needs_isa,
      });
    }
    return rows;
  }

  function unique(list) {
    return list.filter((v, i) => list.indexOf(v) === i);
  }

  function findRow(catalog, sys, arch) {
    return catalog.find((r) => r.sys === sys && r.arch === arch) || null;
  }

  // the choices a row offers on one of its axes, given the rest of the selection
  function rowChoices(row, key, target) {
    if (key === "linkage") { return row.linkage[target.env || "none"] || []; }
    return row[key] || [];
  }

  // the value a row axis takes when the selection names none it offers
  function defaultChoice(choices) {
    const starred = choices.find((c) => c.isDefault);
    return starred ? starred.name : choices.length ? choices[0].name : "";
  }

  // a complete, valid selection nearest to `want`: the row its system and
  // architecture name, then each row axis kept where the row offers it and
  // defaulted where it does not. `pinned` names the axis the user just set,
  // which the other of system and architecture gives way to. an instruction
  // set and its extensions belong to an architecture, and go when it changes
  function resolveTarget(catalog, want, pinned) {
    const w = Object.assign({}, DEFAULT_TARGET, want || {});
    let row = findRow(catalog, w.sys, w.arch);
    if (!row && pinned === "arch") { row = catalog.find((r) => r.arch === w.arch); }
    if (!row) { row = catalog.find((r) => r.sys === w.sys) || catalog.find((r) => r.arch === w.arch) || catalog[0]; }
    const out = { sys: row.sys, arch: row.arch };
    for (const key of ["env", "abi", "codeModel", "linkage"]) {
      const choices = rowChoices(row, key, out);
      out[key] = choices.some((c) => c.name === w[key]) ? w[key] : defaultChoice(choices);
    }
    const sameArch = row.arch === w.arch && pinned !== "arch";
    out.isa = sameArch && w.isa ? String(w.isa).trim() : "";
    if (!out.isa && row.needsIsa) { out.isa = (ISA_PRESETS[row.arch] || [""])[0]; }
    out.ext = sameArch ? normalizeExt(w.ext) : "";
    return out;
  }

  // extension names as one comma-separated string
  function normalizeExt(raw) {
    return unique(String(raw || "").split(/[\s,]+/).filter(Boolean)).join(",");
  }

  // every value of a grid axis, each marked with whether the current
  // selection's other grid axis offers it
  function gridChoices(catalog, key, target) {
    const other = key === "sys" ? "arch" : "sys";
    return unique(catalog.map((r) => r[key])).map((name) => ({
      name,
      available: catalog.some((r) => r[key] === name && r[other] === target[other]),
    }));
  }

  // what the selector shows for one axis: its choices, or for a free axis its
  // suggestions and whether the target must state it
  function axisChoices(catalog, key, target) {
    const row = findRow(catalog, target.sys, target.arch);
    if (key === "sys" || key === "arch") { return gridChoices(catalog, key, target); }
    if (key === "isa") { return { suggestions: ISA_PRESETS[target.arch] || [], required: Boolean(row && row.needsIsa) }; }
    if (key === "ext") { return { suggestions: [], required: false }; }
    return row ? rowChoices(row, key, target) : [];
  }

  function targetName(target) {
    return target.sys + "-" + target.arch;
  }

  // the parts of a selection that differ from its row's defaults, for a label
  function targetDetail(catalog, target) {
    const row = findRow(catalog, target.sys, target.arch);
    const parts = [];
    for (const key of ["env", "abi", "codeModel", "linkage"]) {
      if (row && target[key] && target[key] !== defaultChoice(rowChoices(row, key, target))) { parts.push(target[key]); }
    }
    if (target.isa) { parts.push(target.isa); }
    if (target.ext) { parts.push("+" + target.ext.split(",").join("+")); }
    return parts;
  }

  // how the browser can execute what a target builds, if at all
  function execution(target) {
    if (target.sys === "wasi" && target.arch === "wasm32") { return "program"; }
    if (target.arch === "spirv") { return "shader"; }
    return null;
  }

  function tomlString(s) {
    return '"' + String(s).replace(/[\\"]/g, "\\$&").replace(/[\u0000-\u001f\u007f]/g, "") + '"';
  }

  // the mach.toml a selection builds under. the playground owns this file
  // whole: it is written from the selection and never read back
  function manifest(catalog, settings) {
    const t = settings.target;
    const row = findRow(catalog, t.sys, t.arch);
    const isDefault = (key) => !t[key] || !row || t[key] === defaultChoice(rowChoices(row, key, t));
    const shader = execution(t) === "shader";
    const lines = [
      "[project]",
      "id      = " + tomlString(PROJECT_ID),
      'version = "0.1.0"',
      'mach    = "^7"',
      'src     = "src"',
      'work    = "out/{target.name}/{profile.name}"',
      "",
      "[target." + targetName(t) + "]",
      "arch = " + tomlString(t.arch),
      "sys  = " + tomlString(t.sys),
      "abi  = " + tomlString(t.abi),
    ];
    if (t.env && t.env !== "none") { lines.push("env  = " + tomlString(t.env)); }
    if (t.isa) { lines.push("isa  = " + tomlString(t.isa)); }
    if (t.ext) { lines.push("ext  = [" + t.ext.split(",").map(tomlString).join(", ") + "]"); }
    if (!isDefault("codeModel")) { lines.push("code_model = " + tomlString(t.codeModel)); }
    lines.push(
      "",
      "[profile.debug]",
      "default  = true",
      "optimize = false",
      "debug    = true",
      'simd     = "scalarize"',
      "",
      "[profile.release]",
      "optimize = true",
      "debug    = false",
      'simd     = "scalarize"',
      "",
      "[artifact." + PROJECT_ID + "]",
      "kind    = " + tomlString(shader ? "module" : "bin"),
      "entry   = " + tomlString(ENTRY),
      'out     = "{project.work}/' + PROJECT_ID + '{artifact.suffix}"',
      'targets = ["*"]',
    );
    if (!shader && !isDefault("linkage")) { lines.push("linkage = " + tomlString(t.linkage)); }
    lines.push("", "[dep.std]", 'path = "dep/std"', "", "[dep.shader]", 'path = "dep/shader"', "");
    return lines.join("\n");
  }

  function profileName(settings) {
    return settings.optimize ? "release" : "debug";
  }

  // the products one build writes: what the target can execute or list. a
  // target the browser cannot run stops at objects, so nothing has to link
  function emits(settings) {
    const ir = settings.optimize ? "ir-opt" : "ir";
    return execution(settings.target) ? ["exe", ir] : ["obj", "asm", ir];
  }

  // the compiler's arguments for a check or a build, after `mach`
  function command(settings, verb) {
    const argv = [verb, ".", "-t", targetName(settings.target), "-p", profileName(settings)];
    if (verb === "build") {
      for (const e of emits(settings)) { argv.push("--emit", e); }
    }
    return argv;
  }

  // the work directory the manifest gives a selection
  function workDir(settings) {
    return "out/" + targetName(settings.target) + "/" + profileName(settings);
  }

  // a project file's path under src/: segments a `use` path can spell
  function validFileName(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*\.mach$/.test(name);
  }

  // the module a project file is, as a `use` path spells it
  function moduleOf(name) {
    return PROJECT_ID + "." + name.replace(/\.mach$/, "").split("/").join(".");
  }

  // the compiler's --report json stream, sorted by record kind. a line that
  // is not a record is kept as text, since only a crash writes one
  function parseRecords(text) {
    const out = { diagnostics: [], phases: [], targets: [], host: null, summary: null, stray: [] };
    for (const line of String(text || "").split("\n")) {
      if (!line.trim()) { continue; }
      let rec = null;
      try { rec = JSON.parse(line); } catch (_e) { rec = null; }
      if (!rec || typeof rec !== "object" || !rec.record) {
        out.stray.push(line);
      } else if (rec.record === "diagnostic") {
        out.diagnostics.push(rec);
      } else if (rec.record === "phase") {
        out.phases.push(rec);
      } else if (rec.record === "target") {
        out.targets.push(rec);
      } else if (rec.record === "host") {
        out.host = rec;
      } else if (rec.record === "summary") {
        out.summary = rec;
      }
    }
    return out;
  }

  function formatDuration(us) {
    if (us < 1000) { return Math.round(us) + "us"; }
    if (us < 1000000) { return (us / 1000).toFixed(us < 10000 ? 1 : 0) + "ms"; }
    return (us / 1000000).toFixed(2) + "s";
  }

  function formatBytes(n) {
    if (n < 1024) { return n + " B"; }
    if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + " KiB"; }
    return (n / 1024 / 1024).toFixed(1) + " MiB";
  }

  async function pipeBytes(bytes, stream) {
    const writer = stream.writable.getWriter();
    // bad input fails the read below, which is where it is reported
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  }

  function toBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) { bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(text) {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return bytes;
  }

  // a session as a link fragment: its json, deflated, in url-safe base64
  // behind the format's version
  async function encodeShare(session) {
    const json = new TextEncoder().encode(JSON.stringify(session));
    return "1" + toBase64Url(await pipeBytes(json, new CompressionStream("deflate-raw")));
  }

  // the session a fragment holds, or null when it holds none this build reads
  async function decodeShare(fragment) {
    const m = /^#?code=1([A-Za-z0-9_-]+)$/.exec(fragment || "");
    if (!m) { return null; }
    try {
      const json = await pipeBytes(fromBase64Url(m[1]), new DecompressionStream("deflate-raw"));
      return cleanSession(JSON.parse(new TextDecoder().decode(json)));
    } catch (_e) {
      return null;
    }
  }

  // a session read from a link or from storage, reduced to what a session
  // holds, or null when it is not one. the target is resolved by its reader
  function cleanSession(raw) {
    if (!raw || typeof raw !== "object" || !raw.files || typeof raw.files !== "object") { return null; }
    const files = {};
    for (const name of Object.keys(raw.files)) {
      if (validFileName(name) && typeof raw.files[name] === "string") { files[name] = raw.files[name]; }
    }
    if (typeof files[ENTRY] !== "string") { return null; }
    const target = {};
    for (const axis of AXES) {
      if (raw.target && typeof raw.target[axis.key] === "string") { target[axis.key] = raw.target[axis.key]; }
    }
    return {
      files,
      active: typeof raw.active === "string" && files[raw.active] !== undefined ? raw.active : ENTRY,
      target,
      optimize: raw.optimize !== false,
      args: typeof raw.args === "string" ? raw.args : "",
      example: typeof raw.example === "string" ? raw.example : null,
    };
  }

  const api = {
    PROJECT_ID, ENTRY, AXES, ISA_PRESETS, DEFAULT_TARGET, SHADER_TARGET,
    targetRows, findRow, resolveTarget, axisChoices, normalizeExt,
    targetName, targetDetail, execution,
    manifest, profileName, emits, command, workDir,
    validFileName, moduleOf, parseRecords, formatDuration, formatBytes,
    encodeShare, decodeShare, cleanSession,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    self.machProject = api;
  }
})();
