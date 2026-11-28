// runs one built program to its exit, in a worker of its own: the program
// holds the thread until it ends, so stopping it is terminating this worker.
// the page sends { wasm, args }, reads { fd, text } for every write as the
// program makes it, and last { exit: { exitCode, trap, ms, truncated } }.
(function () {
  "use strict";

  importScripts("wasi.js");
  const wasi = self.machWasi;

  const MAX_OUTPUT_BYTES = 1024 * 1024;

  // thrown through the program to end it once it has written too much
  function OutputLimit() {}

  self.onmessage = async (ev) => {
    const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
    let total = 0;
    let limited = false;

    // each write is posted as it happens. a program that hangs after printing
    // never yields again, so anything held back here would never be seen
    function onOutput(fd, bytes) {
      const room = MAX_OUTPUT_BYTES - total;
      const taken = bytes.length > room ? bytes.subarray(0, room) : bytes;
      total += taken.length;
      self.postMessage({ fd, text: decoders[fd].decode(taken, { stream: true }) });
      if (taken.length < bytes.length) {
        limited = true;
        throw new OutputLimit();
      }
    }

    let exit = null;
    try {
      const ran = await wasi.runWasi(ev.data.wasm, {
        argv: ["main"].concat(wasi.splitArgs(ev.data.args)),
        onOutput,
      });
      exit = { exitCode: ran.exitCode, trap: ran.trap, ms: ran.ms, truncated: false };
    } catch (err) {
      exit = { exitCode: 0, trap: err && err.message ? err.message : String(err), ms: 0, truncated: false };
    }
    // the limit unwinds the program as a trap would, and is reported as itself
    if (limited) {
      exit.truncated = true;
      exit.trap = null;
    }
    self.postMessage({ exit });
  };
})();
