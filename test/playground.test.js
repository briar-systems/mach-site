// run with: node --test test/playground.test.js
// the playground's logic without a browser: the target model, the share
// codec and the page's wiring always, and with the compiler built (see
// public/playground/) every example through mach.wasm itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC = path.resolve(__dirname, "..", "public");
const ASSETS = path.join(PUBLIC, "assets", "playground");
const project = require(path.join(ASSETS, "project.js"));
const wasi = require(path.join(ASSETS, "wasi.js"));
const spirv = require(path.join(ASSETS, "spirv.js"));
const examples = require(path.join(ASSETS, "examples.js"));
const { createCompiler } = require(path.join(ASSETS, "compiler.js"));

const MACH_WASM = path.join(PUBLIC, "playground", "mach.wasm");
const LIBS_JSON = path.join(PUBLIC, "playground", "libs.json");
// the compiler and the libraries are build products, absent from a bare checkout
const built = fs.existsSync(MACH_WASM) && fs.existsSync(LIBS_JSON);
const needsCompiler = { skip: built ? false : "public/playground/mach.wasm and libs.json are not built" };

// the `target` records of `mach info targets --report json`, cut to the rows
// the cases below read
const RECORDS = [
  "{\"schema\":3,\"record\":\"target\",\"name\":\"linux-x86_64\",\"sys\":\"linux\",\"arch\":\"x86_64\",\"envs\":[{\"default\":true,\"name\":null,\"linkages\":[{\"default\":true,\"name\":\"static\",\"abi\":null}]},{\"default\":false,\"name\":\"gnu\",\"linkages\":[{\"default\":true,\"name\":\"pie\",\"abi\":null},{\"default\":false,\"name\":\"dynamic\",\"abi\":null},{\"default\":false,\"name\":\"static\",\"abi\":null}]}],\"abis\":[{\"default\":true,\"name\":\"sysv64\"}],\"code_models\":[{\"default\":true,\"name\":\"small\"}],\"needs_isa\":false}",
  "{\"schema\":3,\"record\":\"target\",\"name\":\"linux-riscv64\",\"sys\":\"linux\",\"arch\":\"riscv64\",\"envs\":[{\"default\":true,\"name\":null,\"linkages\":[{\"default\":true,\"name\":\"static\",\"abi\":null}]},{\"default\":false,\"name\":\"gnu\",\"linkages\":[{\"default\":true,\"name\":\"pie\",\"abi\":null},{\"default\":false,\"name\":\"dynamic\",\"abi\":null},{\"default\":false,\"name\":\"static\",\"abi\":null}]}],\"abis\":[{\"default\":true,\"name\":\"lp64d\"},{\"default\":false,\"name\":\"lp64\"},{\"default\":false,\"name\":\"lp64f\"}],\"code_models\":[{\"default\":true,\"name\":\"medany\"}],\"needs_isa\":false}",
  "{\"schema\":3,\"record\":\"target\",\"name\":\"linux-riscv32\",\"sys\":\"linux\",\"arch\":\"riscv32\",\"envs\":[{\"default\":true,\"name\":null,\"linkages\":[{\"default\":true,\"name\":\"static\",\"abi\":null}]},{\"default\":false,\"name\":\"gnu\",\"linkages\":[{\"default\":true,\"name\":\"pie\",\"abi\":null},{\"default\":false,\"name\":\"dynamic\",\"abi\":null},{\"default\":false,\"name\":\"static\",\"abi\":null}]}],\"abis\":[{\"default\":false,\"name\":\"ilp32\"},{\"default\":false,\"name\":\"ilp32f\"},{\"default\":false,\"name\":\"ilp32d\"}],\"code_models\":[{\"default\":true,\"name\":\"medany\"}],\"needs_isa\":true}",
  "{\"schema\":3,\"record\":\"target\",\"name\":\"freestanding-riscv64\",\"sys\":\"freestanding\",\"arch\":\"riscv64\",\"envs\":[{\"default\":true,\"name\":null,\"linkages\":[{\"default\":true,\"name\":\"static\",\"abi\":null}]}],\"abis\":[{\"default\":false,\"name\":\"lp64\"},{\"default\":false,\"name\":\"lp64f\"},{\"default\":false,\"name\":\"lp64d\"}],\"code_models\":[{\"default\":true,\"name\":\"medany\"},{\"default\":false,\"name\":\"medlow\"}],\"needs_isa\":true}",
  "{\"schema\":3,\"record\":\"target\",\"name\":\"wasi-wasm32\",\"sys\":\"wasi\",\"arch\":\"wasm32\",\"envs\":[{\"default\":true,\"name\":\"preview1\",\"linkages\":[{\"default\":true,\"name\":\"static\",\"abi\":null}]}],\"abis\":[{\"default\":true,\"name\":\"basic\"}],\"code_models\":[],\"needs_isa\":false}",
  "{\"schema\":3,\"record\":\"target\",\"name\":\"vulkan-spirv\",\"sys\":\"vulkan\",\"arch\":\"spirv\",\"envs\":[{\"default\":true,\"name\":null,\"linkages\":[]},{\"default\":false,\"name\":\"vulkan1.0\",\"linkages\":[]},{\"default\":false,\"name\":\"vulkan1.1\",\"linkages\":[]},{\"default\":false,\"name\":\"vulkan1.2\",\"linkages\":[]},{\"default\":false,\"name\":\"vulkan1.3\",\"linkages\":[]}],\"abis\":[{\"default\":true,\"name\":\"shader\"}],\"code_models\":[],\"needs_isa\":false}",
].join("\n");
const catalog = () => project.targetRows(project.parseRecords(RECORDS).targets);

const HELLO = fs.readFileSync(path.join(PUBLIC, "examples", "hello.mach"), "utf8");

function exampleFiles(example) {
  const files = {};
  for (const name of Object.keys(example.files)) { files[name] = fs.readFileSync(path.join(PUBLIC, example.files[name]), "utf8"); }
  return files;
}

let compiler = null;
function getCompiler() {
  compiler = compiler || createCompiler({
    module: () => WebAssembly.compile(fs.readFileSync(MACH_WASM)),
    libs: async () => JSON.parse(fs.readFileSync(LIBS_JSON, "utf8")),
  });
  return compiler;
}

async function runProgram(wasm, args) {
  let out = "";
  const dec = new TextDecoder();
  const ran = await wasi.runWasi(await WebAssembly.compile(wasm), {
    argv: ["main"].concat(wasi.splitArgs(args)),
    onOutput: (_fd, bytes) => { out += dec.decode(bytes, { stream: true }); },
  });
  return Object.assign(ran, { out });
}

test("the target records read into rows with their defaults", () => {
  const rows = catalog();
  assert.deepEqual(rows.map((r) => r.name), ["linux-x86_64", "linux-riscv64", "linux-riscv32", "freestanding-riscv64", "wasi-wasm32", "vulkan-spirv"]);
  const rv = rows[1];
  assert.deepEqual([rv.sys, rv.arch, rv.needsIsa], ["linux", "riscv64", false]);
  assert.deepEqual(rv.abi, [{ name: "lp64d", isDefault: true }, { name: "lp64", isDefault: false }, { name: "lp64f", isDefault: false }]);
  assert.deepEqual(rv.linkage.gnu.map((c) => c.name), ["pie", "dynamic", "static"]);
  assert.equal(rows[2].needsIsa, true);
  assert.deepEqual(rows[4].codeModel, []);
  assert.deepEqual(project.parseRecords("nonsense").targets, []);
});

test("a selection resolves to the nearest target the catalog has", () => {
  const rows = catalog();
  assert.deepEqual(project.resolveTarget(rows), { sys: "wasi", arch: "wasm32", env: "preview1", abi: "basic", codeModel: "", linkage: "static", isa: "", ext: "" });
  // the axis just set is kept, and the other of system and architecture gives way
  assert.equal(project.targetName(project.resolveTarget(rows, { sys: "wasi", arch: "riscv64" }, "arch")), "linux-riscv64");
  assert.equal(project.targetName(project.resolveTarget(rows, { sys: "vulkan", arch: "riscv64" }, "sys")), "vulkan-spirv");
  // a row with no default takes its first choice, and one that needs an isa is given one
  const rv32 = project.resolveTarget(rows, { sys: "linux", arch: "riscv32" });
  assert.deepEqual([rv32.abi, rv32.isa], ["ilp32", "rv32imac"]);
  // what the row does not offer falls back, and what it offers is kept
  const rv64 = project.resolveTarget(rows, { sys: "linux", arch: "riscv64", abi: "lp64", env: "gnu", linkage: "dynamic", ext: "zba, zbb zba" });
  assert.deepEqual([rv64.abi, rv64.env, rv64.linkage, rv64.ext], ["lp64", "gnu", "dynamic", "zba,zbb"]);
  assert.equal(project.resolveTarget(rows, { sys: "linux", arch: "riscv64", abi: "win64" }).abi, "lp64d");
  // an isa and its extensions stay with the architecture, and go when it changes
  const tuned = Object.assign({}, rv64, { isa: "rv64gc" });
  assert.deepEqual([project.resolveTarget(rows, tuned, "abi").isa, project.resolveTarget(rows, tuned, "abi").ext], ["rv64gc", "zba,zbb"]);
  const moved = project.resolveTarget(rows, Object.assign({}, tuned, { arch: "x86_64" }), "arch");
  assert.deepEqual([moved.isa, moved.ext], ["", ""]);
  const pushed = project.resolveTarget(rows, Object.assign({}, tuned, { sys: "vulkan" }), "sys");
  assert.deepEqual([pushed.arch, pushed.isa, pushed.ext], ["spirv", "", ""]);
  const grid = project.axisChoices(rows, "arch", rv64);
  assert.equal(grid.find((c) => c.name === "x86_64").available, true);
  assert.equal(grid.find((c) => c.name === "spirv").available, false);
  assert.deepEqual(project.targetDetail(rows, rv64), ["gnu", "lp64", "dynamic", "+zba+zbb"]);
});

test("a selection writes its manifest and its command", () => {
  const rows = catalog();
  const cpu = { target: project.resolveTarget(rows, { sys: "freestanding", arch: "riscv64", codeModel: "medlow", ext: "zba", isa: 'rv64gc"x' }), optimize: true };
  const toml = project.manifest(rows, cpu);
  assert.match(toml, /\[target\.freestanding-riscv64\]\narch = "riscv64"\nsys  = "freestanding"\nabi  = "lp64"\nisa  = "rv64gc\\"x"\next  = \["zba"\]\ncode_model = "medlow"\n/);
  assert.match(toml, /kind    = "bin"/);
  assert.doesNotMatch(toml, /^env/m);
  assert.deepEqual(project.command(cpu, "build"), ["build", ".", "-t", "freestanding-riscv64", "-p", "release", "--emit", "obj", "--emit", "asm", "--emit", "ir-opt"]);
  const shader = { target: project.resolveTarget(rows, project.SHADER_TARGET), optimize: false };
  assert.match(project.manifest(rows, shader), /env  = "vulkan1\.3"/);
  assert.match(project.manifest(rows, shader), /kind    = "module"/);
  assert.deepEqual(project.command(shader, "build"), ["build", ".", "-t", "vulkan-spirv", "-p", "debug", "--emit", "exe", "--emit", "ir"]);
  assert.deepEqual(project.command(shader, "check"), ["check", ".", "-t", "vulkan-spirv", "-p", "debug"]);
  assert.deepEqual([project.execution(cpu.target), project.execution(shader.target), project.execution(project.resolveTarget(rows))], [null, "shader", "program"]);
  const dynamic = { target: project.resolveTarget(rows, { sys: "linux", arch: "x86_64", env: "gnu", linkage: "dynamic" }), optimize: true };
  assert.match(project.manifest(rows, dynamic), /linkage = "dynamic"/);
});

test("project file names are paths a use can spell", () => {
  for (const good of ["main.mach", "vec.mach", "geo/shape_2.mach", "_x.mach"]) { assert.equal(project.validFileName(good), true, good); }
  for (const bad of ["", "main", "a b.mach", "2d.mach", "../x.mach", "a//b.mach", "a.mach/b.mach", "x.toml"]) { assert.equal(project.validFileName(bad), false, bad); }
  assert.equal(project.moduleOf("geo/shape.mach"), "play.geo.shape");
});

test("a share link holds a session and nothing else", async () => {
  const session = {
    files: { "main.mach": "use play.vec;\n# ünïcode\n", "vec.mach": "pub fun f() i64 { ret 1; }\n" },
    active: "vec.mach",
    target: { sys: "linux", arch: "riscv64", env: "none", abi: "lp64", codeModel: "medany", linkage: "static", isa: "", ext: "zba" },
    optimize: false,
    args: '42 "two words"',
    example: "modules",
  };
  const link = "#code=" + await project.encodeShare(session);
  assert.match(link, /^#code=1[A-Za-z0-9_-]+$/);
  assert.deepEqual(await project.decodeShare(link), session);
  assert.deepEqual(await project.decodeShare(link.slice(1)), session);
  assert.equal(await project.decodeShare("#code=1!!!"), null);
  assert.equal(await project.decodeShare("#code=1AAAA"), null);
  assert.equal(await project.decodeShare(""), null);
  // what a link may not carry is dropped: other files, other keys, a missing entry
  const cleaned = project.cleanSession({ files: { "main.mach": "x", "../evil.mach": "y", "mach.toml": "z", "n.mach": 4 }, active: "gone.mach", target: { sys: "wasi", junk: 1 }, extra: true });
  assert.deepEqual(cleaned, { files: { "main.mach": "x" }, active: "main.mach", target: { sys: "wasi" }, optimize: true, args: "", example: null });
  assert.equal(project.cleanSession({ files: { "other.mach": "x" } }), null);
  assert.equal(project.cleanSession(null), null);
});

test("an argument line splits as a shell would", () => {
  assert.deepEqual(wasi.splitArgs('42 "two words" \'three\'  x"y z"'), ["42", "two words", "three", "xy z"]);
  assert.deepEqual(wasi.splitArgs('a ""'), ["a", ""]);
  assert.deepEqual(wasi.splitArgs("   "), []);
});

test("the in-memory filesystem keeps an unchanged file's mtime", () => {
  const fsys = wasi.makeFs();
  fsys.write("/src/a/b.mach", "one");
  const node = fsys.nodes.get("/src/a/b.mach");
  const stamp = node.mtime;
  node.mtime = 1n;
  fsys.write("/src/a/b.mach", "one");
  assert.equal(node.mtime, 1n);
  fsys.write("/src/a/b.mach", "two");
  assert.notEqual(node.mtime, 1n);
  assert.ok(stamp > 1n);
  assert.deepEqual(fsys.files("/src"), ["a/b.mach"]);
  fsys.remove("/src/a");
  assert.deepEqual(fsys.files("/"), []);
  assert.equal(fsys.readText("/src/a/b.mach"), null);
});

test("every example names files that exist, under names the project accepts", () => {
  const ids = new Set();
  for (const example of examples) {
    assert.ok(!ids.has(example.id), example.id);
    ids.add(example.id);
    assert.ok(example.kind === "program" || example.kind === "shader", example.id);
    assert.ok(example.files[project.ENTRY], example.id);
    for (const name of Object.keys(example.files)) {
      assert.equal(project.validFileName(name), true, name);
      assert.ok(fs.existsSync(path.join(PUBLIC, example.files[name])), example.files[name]);
    }
  }
});

test("the page loads every script and element its code names", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "playground", "index.html"), "utf8");
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) { assert.ok(fs.existsSync(path.join(PUBLIC, m[1])), m[1]); }
  const js = fs.readFileSync(path.join(ASSETS, "playground.js"), "utf8");
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  for (const m of js.matchAll(/\$\("(pg-[a-z-]+)"\)/g)) { assert.ok(ids.has(m[1]), "playground.js reads #" + m[1]); }
});

test("the compiler reports itself, its targets and its libraries", needsCompiler, async () => {
  const info = await getCompiler().init();
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(Object.keys(info.libs), ["std", "shader"]);
  assert.ok(info.libs.std.files.includes("print.mach"));
  assert.ok(info.libs.shader.files.includes("math.mach"));
  for (const name of ["linux-x86_64", "wasi-wasm32", "vulkan-spirv", "freestanding-riscv32e"]) { assert.ok(info.targets.some((r) => r.name === name), name); }
  const lib = await getCompiler().readLib({ path: "dep/std/src/print.mach" });
  assert.match(lib.text, /pub fun println/);
  assert.equal((await getCompiler().readLib({ path: "dep/../mach.toml" })).text, null);
});

test("every target the catalog lists yields a manifest the compiler accepts", needsCompiler, async () => {
  const info = await getCompiler().init();
  for (const row of info.targets) {
    const target = project.resolveTarget(info.targets, { sys: row.sys, arch: row.arch });
    const report = await getCompiler().check({ files: { "main.mach": "pub fun one() i64 {\n    ret 1;\n}\n" }, settings: { target, optimize: true } });
    assert.equal(report.ok, true, row.name + ": " + JSON.stringify(report.diagnostics.map((d) => d.message)) + report.stray);
    // every instruction set the selector suggests is one the architecture
    // spells. whether it holds what the row's default abi needs is the user's
    // combination to make, and the compiler's to refuse
    for (const isa of project.ISA_PRESETS[row.arch] || []) {
      const tuned = await getCompiler().check({ files: { "main.mach": "pub fun one() i64 {\n    ret 1;\n}\n" }, settings: { target: Object.assign({}, target, { isa }), optimize: true } });
      for (const d of tuned.diagnostics) { assert.match(d.message, /calling convention/, row.name + " " + isa); }
    }
  }
});

test("a mistake comes back as a diagnostic with its source line and a fix", needsCompiler, async () => {
  const info = await getCompiler().init();
  const source = HELLO.replace("print.println", "print.printn");
  const report = await getCompiler().check({ files: { "main.mach": source }, settings: { target: project.resolveTarget(info.targets), optimize: true } });
  assert.equal(report.ok, false);
  const d = report.diagnostics.find((x) => x.severity === "error");
  assert.equal(d.primary.file, "src/main.mach");
  assert.equal(d.primary.text, source.split("\n")[d.primary.line - 1]);
  assert.match(d.message, /printn/);
});

test("every program example builds for wasi and runs to exit 0", needsCompiler, async () => {
  const info = await getCompiler().init();
  for (const example of examples.filter((e) => e.kind === "program")) {
    const result = await getCompiler().build({ files: exampleFiles(example), settings: { target: project.resolveTarget(info.targets), optimize: true } });
    assert.equal(result.ok, true, example.id + ": " + JSON.stringify(result.diagnostics.map((d) => d.message)));
    assert.ok(result.ir.length >= 1 && result.ir[0].file === "main.mach", example.id);
    const ran = await runProgram(result.artifact, example.args || "");
    assert.equal(ran.trap, null, example.id);
    assert.equal(ran.exitCode, 0, example.id + ": " + ran.out);
  }
});

test("a program builds to assembly for a target the browser cannot run", needsCompiler, async () => {
  const info = await getCompiler().init();
  const files = exampleFiles(examples.find((e) => e.id === "modules"));
  const result = await getCompiler().build({ files, settings: { target: project.resolveTarget(info.targets, { sys: "linux", arch: "aarch64" }), optimize: true } });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.map((d) => d.message)));
  assert.equal(result.artifact, null);
  assert.deepEqual(result.asm.map((l) => l.file), ["main.mach", "vec.mach"]);
  assert.match(result.asm[1].text, /play\.vec\.dot/);
  assert.deepEqual(result.ir.map((l) => l.file), ["main.mach", "vec.mach"]);
  // a file removed from the session leaves no listing behind
  const alone = await getCompiler().build({ files: { "main.mach": HELLO }, settings: { target: project.resolveTarget(info.targets, { sys: "linux", arch: "aarch64" }), optimize: true } });
  assert.deepEqual(alone.asm.map((l) => l.file), ["main.mach"]);
});

test("every shader example builds, lists and translates to glsl in both profiles", needsCompiler, async () => {
  const info = await getCompiler().init();
  for (const example of examples.filter((e) => e.kind === "shader")) {
    for (const optimize of [true, false]) {
      const where = example.id + (optimize ? " release" : " debug");
      const result = await getCompiler().build({ files: exampleFiles(example), settings: { target: project.resolveTarget(info.targets, project.SHADER_TARGET), optimize } });
      assert.equal(result.ok, true, where + ": " + JSON.stringify(result.diagnostics.map((d) => d.message)));
      assert.equal(result.diagnostics.length, 0, where);
      const listing = spirv.disassemble(result.artifact);
      assert.equal(listing.ok, true, where);
      assert.match(listing.text, /^OpCapability Shader$/m, where);
      assert.match(listing.text, /^OpEntryPoint Fragment %\S+ "shade"/m, where);
      assert.doesNotMatch(listing.text, /^\s*Op\d/m, where);
      assert.deepEqual(listing.stages, [{ name: "shade", model: "fragment" }], where);
      const glsl = spirv.toGlsl(result.artifact);
      assert.equal(glsl.ok, true, where + ": " + glsl.reason);
      assert.match(glsl.glsl, /^#version 300 es\n/, where);
      assert.match(glsl.glsl, /layout\(location = 0\) out vec4 g\d+;/, where);
      // the frame block's leaves, at the offsets the preview feeds them from
      assert.deepEqual(glsl.bindings.map((b) => [b.type, b.offset]), [["vec2", 0], ["float", 8], ["float", 12], ["vec2", 16], ["float", 24]], where);
    }
  }
});

test("a module the preview cannot draw is refused with its reason", needsCompiler, async () => {
  const info = await getCompiler().init();
  const compute = [
    "#[gpu.builtin(\"global_invocation\")]",
    "var gid: u32x3;",
    "",
    "#[gpu.stage(\"compute\")]",
    "#[gpu.workgroup(8, 8, 1)]",
    "fun work() {",
    "}",
    "",
  ].join("\n");
  const result = await getCompiler().build({ files: { "main.mach": compute }, settings: { target: project.resolveTarget(info.targets, project.SHADER_TARGET), optimize: true } });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.map((d) => d.message)));
  assert.equal(spirv.disassemble(result.artifact).stages[0].model, "glcompute");
  assert.deepEqual(spirv.toGlsl(result.artifact), { ok: false, reason: "the module has no fragment stage, and the preview draws fragment stages" });
  assert.equal(spirv.toGlsl(new Uint8Array(8)).ok, false);
});

test("mach fmt formats through the compiler's stdin", needsCompiler, async () => {
  const good = await getCompiler().format({ source: "fun  f( ) i64 {ret 1;}\n" });
  assert.deepEqual(good, { ok: true, source: "fun f() i64 {\n    ret 1;\n}\n", message: "" });
  const bad = await getCompiler().format({ source: "fun (" });
  assert.equal(bad.ok, false);
  assert.ok(bad.message.length > 0);
});
