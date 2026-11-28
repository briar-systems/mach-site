// draws a module's fragment stage on a canvas, as a pipeline that owns one
// full-screen triangle would. what the shader may read is the frame block
// below, fed to every uniform and push constant block by byte offset, so a
// shader declares as much of it as it uses:
//
//   offset  type   field
//        0  f32x2  resolution  the canvas, in pixels
//        8  f32    time        seconds since the shader started
//       12  f32    delta       seconds since the frame before
//       16  f32x2  pointer     the pointer, in pixels from the top left
//       24  f32    pressed     1.0 while the pointer is held down
//
// `#[gpu.builtin("frag_coord")]` reads as vulkan has it, origin top left, and
// an f32x2 `#[gpu.input(0)]` is the fragment's place in the canvas from 0 to 1.
(function () {
  "use strict";

  const FRAME_BYTES = 32;
  const VERTEX = [
    "#version 300 es",
    "void main() {",
    "  gl_Position = vec4(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID & 2) * 2 - 1), 0.0, 1.0);",
    "}",
  ].join("\n");

  // onStats({ width, height, fps }) is called about twice a second while drawing
  function createPreview(canvas, onStats) {
    let gl = null;
    let program = null;
    let uniforms = [];
    let viewport = null;
    let raf = 0;
    let paused = false;
    let visible = false;
    // shader time only advances while frames are drawn
    let time = 0;
    let lastFrame = 0;
    let frames = 0;
    let statsAt = 0;
    let pointer = null;
    let pressed = false;
    const frame = new DataView(new ArrayBuffer(FRAME_BYTES));

    function compile(kind, source) {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { return { shader }; }
      const log = gl.getShaderInfoLog(shader) || "unknown error";
      gl.deleteShader(shader);
      return { log };
    }

    // the canvas's backing store at one pixel per device pixel
    function resize(entry) {
      const dpr = window.devicePixelRatio || 1;
      const box = entry && entry.devicePixelContentBoxSize && entry.devicePixelContentBoxSize[0];
      const width = Math.max(1, box ? box.inlineSize : Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, box ? box.blockSize : Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        if (paused) { draw(0); }
      }
    }

    const observer = new ResizeObserver((entries) => resize(entries[0]));
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch (_e) {
      observer.observe(canvas);
    }

    function trackPointer(ev) {
      const rect = canvas.getBoundingClientRect();
      pointer = {
        x: (ev.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
        y: (ev.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
      };
      if (paused) { draw(0); }
    }
    canvas.addEventListener("pointermove", trackPointer);
    canvas.addEventListener("pointerdown", (ev) => {
      pressed = true;
      canvas.setPointerCapture(ev.pointerId);
      trackPointer(ev);
    });
    const release = () => {
      pressed = false;
      if (paused) { draw(0); }
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);

    // sets one uniform leaf from the frame block's bytes at its offset
    function feed(u) {
      const at = (i) => (u.offset + i * 4 + 4 <= FRAME_BYTES ? u.offset + i * 4 : -1);
      const float = (i) => (at(i) < 0 ? 0 : frame.getFloat32(at(i), true));
      const int = (i) => (at(i) < 0 ? 0 : frame.getInt32(at(i), true));
      const uint = (i) => (at(i) < 0 ? 0 : frame.getUint32(at(i), true));
      switch (u.type) {
        case "float": gl.uniform1f(u.location, float(0)); break;
        case "vec2": gl.uniform2f(u.location, float(0), float(1)); break;
        case "vec3": gl.uniform3f(u.location, float(0), float(1), float(2)); break;
        case "vec4": gl.uniform4f(u.location, float(0), float(1), float(2), float(3)); break;
        case "int": case "bool": gl.uniform1i(u.location, int(0)); break;
        case "ivec2": case "bvec2": gl.uniform2i(u.location, int(0), int(1)); break;
        case "ivec3": case "bvec3": gl.uniform3i(u.location, int(0), int(1), int(2)); break;
        case "ivec4": case "bvec4": gl.uniform4i(u.location, int(0), int(1), int(2), int(3)); break;
        case "uint": gl.uniform1ui(u.location, uint(0)); break;
        case "uvec2": gl.uniform2ui(u.location, uint(0), uint(1)); break;
        case "uvec3": gl.uniform3ui(u.location, uint(0), uint(1), uint(2)); break;
        case "uvec4": gl.uniform4ui(u.location, uint(0), uint(1), uint(2), uint(3)); break;
        default: break;
      }
    }

    function draw(delta) {
      if (!program) { return; }
      const at = pointer || { x: canvas.width / 2, y: canvas.height / 2 };
      frame.setFloat32(0, canvas.width, true);
      frame.setFloat32(4, canvas.height, true);
      frame.setFloat32(8, time, true);
      frame.setFloat32(12, delta, true);
      frame.setFloat32(16, at.x, true);
      frame.setFloat32(20, at.y, true);
      frame.setFloat32(24, pressed ? 1 : 0, true);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      if (viewport) { gl.uniform2f(viewport, canvas.width, canvas.height); }
      uniforms.forEach(feed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function tick(now) {
      raf = 0;
      const delta = Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      time += delta;
      draw(delta);
      frames++;
      if (now - statsAt >= 500) {
        onStats({ width: canvas.width, height: canvas.height, fps: Math.round((frames * 1000) / (now - statsAt)) });
        frames = 0;
        statsAt = now;
      }
      schedule();
    }

    // frames run only while a shader is loaded, shown and not paused
    function schedule() {
      const running = program && visible && !paused;
      if (running && !raf) {
        raf = requestAnimationFrame(tick);
      } else if (!running && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function start() {
      lastFrame = performance.now();
      statsAt = lastFrame;
      frames = 0;
      schedule();
    }

    function unload() {
      if (gl && program) { gl.deleteProgram(program); }
      program = null;
      schedule();
    }

    // takes what spirv.toGlsl returned. answers { ok } or { ok: false, reason }
    function load(translated) {
      unload();
      gl = gl || canvas.getContext("webgl2", { antialias: false, alpha: false });
      if (!gl) { return { ok: false, reason: "this browser has no WebGL2 to draw with" }; }
      const vs = compile(gl.VERTEX_SHADER, VERTEX);
      const fs = compile(gl.FRAGMENT_SHADER, translated.glsl);
      if (!fs.shader) { return { ok: false, reason: "the translated shader did not compile:\n" + fs.log }; }
      const made = gl.createProgram();
      gl.attachShader(made, vs.shader);
      gl.attachShader(made, fs.shader);
      gl.linkProgram(made);
      gl.deleteShader(vs.shader);
      gl.deleteShader(fs.shader);
      if (!gl.getProgramParameter(made, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(made) || "unknown error";
        gl.deleteProgram(made);
        return { ok: false, reason: "the translated shader did not link:\n" + log };
      }
      program = made;
      viewport = gl.getUniformLocation(program, "pg_viewport");
      // a leaf the shader never reads has no location, and is not fed
      uniforms = translated.bindings
        .map((b) => ({ type: b.type, offset: b.offset, location: gl.getUniformLocation(program, b.name) }))
        .filter((u) => u.location !== null);
      // time runs on across a reload, so editing a shader does not rewind it
      resize();
      start();
      if (paused) { draw(0); }
      return { ok: true };
    }

    return {
      load,
      unload,
      get paused() { return paused; },
      get loaded() { return Boolean(program); },
      setPaused(next) {
        if (paused === next) { return; }
        paused = next;
        start();
      },
      setVisible(next) {
        if (visible === next) { return; }
        visible = next;
        start();
      },
      restart() {
        time = 0;
        if (paused) { draw(0); }
      },
    };
  }

  self.machPreview = { createPreview };
})();
