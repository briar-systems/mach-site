// the playground's examples. a program builds for wasi and runs, and a shader
// builds for vulkan and is drawn. each names the files it loads into src/.
(function () {
  "use strict";

  const examples = [
    { id: "hello", kind: "program", title: "hello, world", blurb: "the smallest program", files: { "main.mach": "/examples/hello.mach" } },
    { id: "comptime", kind: "program", title: "variadic packs", blurb: "one call site unrolled per argument type", files: { "main.mach": "/examples/comptime.mach" } },
    { id: "parse", kind: "program", title: "results", blurb: "a failure is a value, handled by hand", files: { "main.mach": "/examples/parse.mach" }, args: "42" },
    { id: "alloc", kind: "program", title: "allocators", blurb: "memory comes from an allocator you pass", files: { "main.mach": "/examples/alloc.mach" } },
    { id: "secret", kind: "program", title: "constant time", blurb: "secrets the compiler keeps off every branch", files: { "main.mach": "/examples/secret.mach" } },
    { id: "fib", kind: "program", title: "recursion", blurb: "fibonacci, the slow way", files: { "main.mach": "/examples/main.mach" } },
    { id: "modules", kind: "program", title: "modules", blurb: "two files, one project", files: { "main.mach": "/examples/modules/main.mach", "vec.mach": "/examples/modules/vec.mach" } },
    { id: "cone", kind: "shader", title: "mach cone", blurb: "a source outrunning its own waves", files: { "main.mach": "/examples/shaders/cone.mach" } },
    { id: "raymarch", kind: "shader", title: "sphere tracing", blurb: "a lit torus from a distance function", files: { "main.mach": "/examples/shaders/raymarch.mach" } },
    { id: "julia", kind: "shader", title: "julia set", blurb: "hold the pointer to choose the constant", files: { "main.mach": "/examples/shaders/julia.mach" } },
    { id: "waves", kind: "shader", title: "interference", blurb: "two sources and the lines where they cancel", files: { "main.mach": "/examples/shaders/waves.mach" } },
    { id: "grid", kind: "shader", title: "horizon", blurb: "one-pixel lines from screen-space derivatives", files: { "main.mach": "/examples/shaders/grid.mach" } },
    { id: "truchet", kind: "shader", title: "truchet tiles", blurb: "one tile, turned by a hash of its cell", files: { "main.mach": "/examples/shaders/truchet.mach" } },
  ];

  if (typeof module !== "undefined" && module.exports) {
    module.exports = examples;
  } else {
    self.machExamples = examples;
  }
})();
