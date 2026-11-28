// a wasi_snapshot_preview1 host over an in-memory filesystem: enough of the
// interface to run the mach compiler and the programs it builds, in a worker
// or under node. one preopened directory, "/", and no clock but the host's.
(function () {
  "use strict";

  const ESUCCESS = 0;
  const EBADF = 8;
  const EEXIST = 20;
  const EINVAL = 28;
  const EISDIR = 31;
  const ENOENT = 44;
  const ENOTDIR = 54;
  const ENOTEMPTY = 55;
  const ENOTSUP = 58;

  const FILETYPE_CHARACTER_DEVICE = 2;
  const FILETYPE_DIRECTORY = 3;
  const FILETYPE_REGULAR = 4;

  const OFLAGS_CREAT = 1;
  const OFLAGS_DIRECTORY = 2;
  const OFLAGS_EXCL = 4;
  const OFLAGS_TRUNC = 8;

  const FDFLAGS_APPEND = 1;

  const MAX_FILE_BYTES = 64 * 1024 * 1024;

  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", { fatal: false });

  // thrown through the guest's frames to unwind it at proc_exit
  function ProcExit(code) {
    this.code = code >>> 0;
  }

  // an absolute path with no "." or ".." segment and no trailing slash
  function cleanPath(raw) {
    const out = [];
    for (const part of String(raw || "").split("/")) {
      if (!part || part === ".") { continue; }
      if (part === "..") { out.pop(); continue; }
      out.push(part);
    }
    return "/" + out.join("/");
  }

  function parentOf(path) {
    const at = path.lastIndexOf("/");
    return at <= 0 ? "/" : path.slice(0, at);
  }

  // a flat map of absolute path to node. a file's bytes are buf[0, len), so a
  // growing file reallocates by doubling, never per write
  function makeFs() {
    let nextIno = 1;
    const nodes = new Map();
    const nowNs = () => BigInt(Date.now()) * 1000000n;
    const node = (kind, bytes) => ({
      kind,
      ino: BigInt(nextIno++),
      buf: bytes,
      len: bytes ? bytes.length : 0,
      mtime: nowNs(),
    });

    function mkdirp(raw) {
      const path = cleanPath(raw);
      if (nodes.has(path)) { return; }
      if (path !== "/") { mkdirp(parentOf(path)); }
      nodes.set(path, node("dir", null));
    }

    // identical bytes leave the file and its mtime alone, so a build that
    // reads it again sees an unchanged input
    function write(raw, content) {
      const path = cleanPath(raw);
      const bytes = typeof content === "string" ? enc.encode(content) : new Uint8Array(content);
      const old = nodes.get(path);
      if (old && old.kind === "file") {
        if (old.len === bytes.length && old.buf.subarray(0, old.len).every((b, i) => b === bytes[i])) { return; }
        old.buf = bytes;
        old.len = bytes.length;
        old.mtime = nowNs();
        return;
      }
      mkdirp(parentOf(path));
      nodes.set(path, node("file", bytes));
    }

    function read(raw) {
      const found = nodes.get(cleanPath(raw));
      return found && found.kind === "file" ? found.buf.slice(0, found.len) : null;
    }

    function readText(raw) {
      const bytes = read(raw);
      return bytes ? dec.decode(bytes) : null;
    }

    // removes a file, or a directory and everything under it
    function remove(raw) {
      const path = cleanPath(raw);
      const prefix = path + "/";
      for (const key of Array.from(nodes.keys())) {
        if (key === path || key.startsWith(prefix)) { nodes.delete(key); }
      }
    }

    // every file under a directory, as paths relative to it
    function files(raw) {
      const prefix = cleanPath(raw) === "/" ? "/" : cleanPath(raw) + "/";
      const out = [];
      for (const [path, found] of nodes) {
        if (found.kind === "file" && path.startsWith(prefix)) { out.push(path.slice(prefix.length)); }
      }
      return out.sort();
    }

    mkdirp("/");
    return { nodes, node, nowNs, mkdirp, write, read, readText, remove, files };
  }

  // runs one command module to its exit. options: argv, env, stdin (bytes or
  // text), fs, and onOutput(fd, bytes) called for each write to fd 1 or 2 with
  // a view that is only valid during the call
  async function runWasi(module, options) {
    const opts = options || {};
    const argv = (opts.argv || ["main"]).map((a) => enc.encode(String(a) + "\0"));
    const env = (opts.env || ["HOME=/", "TMPDIR=/tmp", "NO_COLOR=1"]).map((e) => enc.encode(String(e) + "\0"));
    const stdin = opts.stdin instanceof Uint8Array ? opts.stdin : enc.encode(String(opts.stdin || ""));
    const onOutput = opts.onOutput || (() => {});
    const fs = opts.fs || makeFs();
    fs.mkdirp("/tmp");
    let stdinPos = 0;

    const fds = new Map();
    fds.set(0, { kind: "stdio" });
    fds.set(1, { kind: "stdio" });
    fds.set(2, { kind: "stdio" });
    fds.set(3, { kind: "dir", path: "/", preopen: "/" });
    let nextFd = 4;

    let memory = null;
    const u8 = () => new Uint8Array(memory.buffer);
    const view = () => new DataView(memory.buffer);

    // a guest path under a directory descriptor, as an absolute path
    function pathAt(fd, ptr, len) {
      const dir = fds.get(fd);
      if (!dir || dir.kind !== "dir") { return { err: EBADF }; }
      const raw = dec.decode(u8().subarray(ptr >>> 0, (ptr >>> 0) + (len >>> 0)));
      if (raw.indexOf("\0") !== -1) { return { err: EINVAL }; }
      return { err: 0, path: cleanPath(dir.path + "/" + raw) };
    }

    function writeFilestat(ptr, found) {
      const v = view();
      const at = ptr >>> 0;
      u8().fill(0, at, at + 64);
      v.setBigUint64(at, 1n, true);
      v.setBigUint64(at + 8, found.ino, true);
      v.setUint8(at + 16, found.kind === "dir" ? FILETYPE_DIRECTORY : FILETYPE_REGULAR);
      v.setBigUint64(at + 24, 1n, true);
      v.setBigUint64(at + 32, BigInt(found.len), true);
      v.setBigUint64(at + 40, found.mtime, true);
      v.setBigUint64(at + 48, found.mtime, true);
      v.setBigUint64(at + 56, found.mtime, true);
    }

    function writeStringTable(list, tablePtr, bufPtr) {
      const v = view();
      const mem = u8();
      let at = bufPtr >>> 0;
      list.forEach((bytes, i) => {
        v.setUint32((tablePtr >>> 0) + i * 4, at, true);
        mem.set(bytes, at);
        at += bytes.length;
      });
      return ESUCCESS;
    }

    function writeStringSizes(list, countPtr, sizePtr) {
      const v = view();
      v.setUint32(countPtr >>> 0, list.length, true);
      v.setUint32(sizePtr >>> 0, list.reduce((n, bytes) => n + bytes.length, 0), true);
      return ESUCCESS;
    }

    // walks a guest iovec array, handing each buffer to `each` until it returns false
    function eachIov(iovsPtr, count, each) {
      const v = view();
      for (let i = 0; i < (count >>> 0); i++) {
        const ptr = v.getUint32((iovsPtr >>> 0) + i * 8, true);
        const len = v.getUint32((iovsPtr >>> 0) + i * 8 + 4, true);
        if (len > 0 && each(ptr, len) === false) { return; }
      }
    }

    const wasi = {
      args_sizes_get: (countPtr, sizePtr) => writeStringSizes(argv, countPtr, sizePtr),
      args_get: (tablePtr, bufPtr) => writeStringTable(argv, tablePtr, bufPtr),
      environ_sizes_get: (countPtr, sizePtr) => writeStringSizes(env, countPtr, sizePtr),
      environ_get: (tablePtr, bufPtr) => writeStringTable(env, tablePtr, bufPtr),
      clock_res_get(_id, outPtr) {
        view().setBigUint64(outPtr >>> 0, 1000n, true);
        return ESUCCESS;
      },
      clock_time_get(id, _precision, outPtr) {
        const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1000000));
        view().setBigUint64(outPtr >>> 0, ns, true);
        return ESUCCESS;
      },
      fd_prestat_get(fd, outPtr) {
        const entry = fds.get(fd);
        if (!entry || entry.preopen == null) { return EBADF; }
        view().setUint32(outPtr >>> 0, 0, true);
        view().setUint32((outPtr >>> 0) + 4, enc.encode(entry.preopen).length, true);
        return ESUCCESS;
      },
      fd_prestat_dir_name(fd, namePtr, len) {
        const entry = fds.get(fd);
        if (!entry || entry.preopen == null) { return EBADF; }
        u8().set(enc.encode(entry.preopen).subarray(0, len >>> 0), namePtr >>> 0);
        return ESUCCESS;
      },
      fd_fdstat_get(fd, outPtr) {
        const entry = fds.get(fd);
        if (!entry) { return EBADF; }
        const v = view();
        const at = outPtr >>> 0;
        u8().fill(0, at, at + 24);
        v.setUint8(at, entry.kind === "stdio" ? FILETYPE_CHARACTER_DEVICE : entry.kind === "dir" ? FILETYPE_DIRECTORY : FILETYPE_REGULAR);
        v.setUint16(at + 2, entry.append ? FDFLAGS_APPEND : 0, true);
        v.setBigUint64(at + 8, 0xffffffffffffffffn, true);
        v.setBigUint64(at + 16, 0xffffffffffffffffn, true);
        return ESUCCESS;
      },
      fd_fdstat_set_flags(fd, flags) {
        const entry = fds.get(fd);
        if (!entry) { return EBADF; }
        entry.append = Boolean(flags & FDFLAGS_APPEND);
        return ESUCCESS;
      },
      fd_filestat_get(fd, outPtr) {
        const entry = fds.get(fd);
        if (!entry) { return EBADF; }
        if (entry.kind === "stdio") {
          u8().fill(0, outPtr >>> 0, (outPtr >>> 0) + 64);
          view().setUint8((outPtr >>> 0) + 16, FILETYPE_CHARACTER_DEVICE);
          return ESUCCESS;
        }
        const found = fs.nodes.get(entry.path);
        if (!found) { return ENOENT; }
        writeFilestat(outPtr, found);
        return ESUCCESS;
      },
      fd_filestat_set_size(fd, size) {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== "file") { return EBADF; }
        const found = fs.nodes.get(entry.path);
        if (!found) { return ENOENT; }
        const n = Number(size);
        if (n < 0 || n > MAX_FILE_BYTES) { return EINVAL; }
        if (n > found.buf.length) {
          const grown = new Uint8Array(n);
          grown.set(found.buf.subarray(0, found.len));
          found.buf = grown;
        } else if (n > found.len) {
          found.buf.fill(0, found.len, n);
        }
        found.len = n;
        found.mtime = fs.nowNs();
        return ESUCCESS;
      },
      fd_close(fd) {
        if (fd >= 0 && fd <= 3) { return ESUCCESS; }
        return fds.delete(fd) ? ESUCCESS : EBADF;
      },
      fd_sync: (fd) => (fds.has(fd) ? ESUCCESS : EBADF),
      fd_datasync: (fd) => (fds.has(fd) ? ESUCCESS : EBADF),
      fd_tell(fd, outPtr) {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== "file") { return EBADF; }
        view().setBigUint64(outPtr >>> 0, BigInt(entry.pos), true);
        return ESUCCESS;
      },
      fd_seek(fd, offset, whence, outPtr) {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== "file") { return EBADF; }
        const found = fs.nodes.get(entry.path);
        if (!found) { return ENOENT; }
        const next = (whence === 0 ? 0 : whence === 1 ? entry.pos : found.len) + Number(offset);
        if (next < 0) { return EINVAL; }
        entry.pos = next;
        view().setBigUint64(outPtr >>> 0, BigInt(next), true);
        return ESUCCESS;
      },
      fd_read(fd, iovsPtr, count, donePtr) {
        const entry = fds.get(fd);
        if (!entry) { return EBADF; }
        let total = 0;
        if (fd === 0) {
          eachIov(iovsPtr, count, (ptr, len) => {
            const n = Math.min(len, stdin.length - stdinPos);
            u8().set(stdin.subarray(stdinPos, stdinPos + n), ptr);
            stdinPos += n;
            total += n;
            return n === len;
          });
        } else {
          if (entry.kind !== "file") { return EBADF; }
          const found = fs.nodes.get(entry.path);
          if (!found) { return ENOENT; }
          eachIov(iovsPtr, count, (ptr, len) => {
            const n = Math.max(0, Math.min(len, found.len - entry.pos));
            u8().set(found.buf.subarray(entry.pos, entry.pos + n), ptr);
            entry.pos += n;
            total += n;
            return n === len;
          });
        }
        view().setUint32(donePtr >>> 0, total, true);
        return ESUCCESS;
      },
      fd_pread(fd, iovsPtr, count, offset, donePtr) {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== "file") { return EBADF; }
        const saved = entry.pos;
        entry.pos = Number(offset);
        const rc = wasi.fd_read(fd, iovsPtr, count, donePtr);
        entry.pos = saved;
        return rc;
      },
      fd_write(fd, iovsPtr, count, donePtr) {
        const entry = fds.get(fd);
        if (!entry) { return EBADF; }
        let total = 0;
        let err = ESUCCESS;
        if (fd === 1 || fd === 2) {
          eachIov(iovsPtr, count, (ptr, len) => {
            onOutput(fd, u8().subarray(ptr, ptr + len));
            total += len;
          });
        } else {
          if (entry.kind !== "file") { return EBADF; }
          const found = fs.nodes.get(entry.path);
          if (!found) { return ENOENT; }
          eachIov(iovsPtr, count, (ptr, len) => {
            const at = entry.append ? found.len : entry.pos;
            const end = at + len;
            if (end > MAX_FILE_BYTES) { err = EINVAL; return false; }
            if (end > found.buf.length) {
              const grown = new Uint8Array(Math.min(MAX_FILE_BYTES, Math.max(end, found.buf.length * 2, 4096)));
              grown.set(found.buf.subarray(0, found.len));
              found.buf = grown;
            }
            found.buf.set(u8().subarray(ptr, ptr + len), at);
            found.len = Math.max(found.len, end);
            entry.pos = end;
            total += len;
          });
          found.mtime = fs.nowNs();
        }
        if (err) { return err; }
        view().setUint32(donePtr >>> 0, total, true);
        return ESUCCESS;
      },
      fd_pwrite(fd, iovsPtr, count, offset, donePtr) {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== "file") { return EBADF; }
        const saved = { pos: entry.pos, append: entry.append };
        entry.pos = Number(offset);
        entry.append = false;
        const rc = wasi.fd_write(fd, iovsPtr, count, donePtr);
        entry.pos = saved.pos;
        entry.append = saved.append;
        return rc;
      },
      fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr) {
        const entry = fds.get(fd);
        if (!entry || entry.kind !== "dir") { return EBADF; }
        const prefix = entry.path === "/" ? "/" : entry.path + "/";
        const items = [];
        for (const [path, found] of fs.nodes) {
          if (path !== entry.path && path.startsWith(prefix) && path.indexOf("/", prefix.length) === -1) {
            items.push({ name: enc.encode(path.slice(prefix.length)), found });
          }
        }
        const cap = bufLen >>> 0;
        let used = 0;
        for (let i = Number(cookie); i < items.length && used < cap; i++) {
          const rec = new Uint8Array(24 + items[i].name.length);
          const rv = new DataView(rec.buffer);
          rv.setBigUint64(0, BigInt(i + 1), true);
          rv.setBigUint64(8, items[i].found.ino, true);
          rv.setUint32(16, items[i].name.length, true);
          rv.setUint8(20, items[i].found.kind === "dir" ? FILETYPE_DIRECTORY : FILETYPE_REGULAR);
          rec.set(items[i].name, 24);
          const take = Math.min(rec.length, cap - used);
          u8().set(rec.subarray(0, take), (bufPtr >>> 0) + used);
          used += take;
        }
        view().setUint32(usedPtr >>> 0, used, true);
        return ESUCCESS;
      },
      path_open(dirFd, _dirflags, pathPtr, pathLen, oflags, _base, _inheriting, fdflags, outPtr) {
        const at = pathAt(dirFd, pathPtr, pathLen);
        if (at.err) { return at.err; }
        let found = fs.nodes.get(at.path);
        if (found && (oflags & OFLAGS_CREAT) && (oflags & OFLAGS_EXCL)) { return EEXIST; }
        if (!found) {
          if (!(oflags & OFLAGS_CREAT)) { return ENOENT; }
          const parent = fs.nodes.get(parentOf(at.path));
          if (!parent || parent.kind !== "dir") { return ENOENT; }
          found = (oflags & OFLAGS_DIRECTORY) ? fs.node("dir", null) : fs.node("file", new Uint8Array(0));
          fs.nodes.set(at.path, found);
        }
        if ((oflags & OFLAGS_DIRECTORY) && found.kind !== "dir") { return ENOTDIR; }
        if (found.kind === "dir" && (oflags & OFLAGS_TRUNC)) { return EISDIR; }
        if (found.kind === "file" && (oflags & OFLAGS_TRUNC)) {
          found.len = 0;
          found.mtime = fs.nowNs();
        }
        const fd = nextFd++;
        fds.set(fd, { kind: found.kind, path: at.path, pos: 0, append: Boolean(fdflags & FDFLAGS_APPEND) });
        view().setInt32(outPtr >>> 0, fd, true);
        return ESUCCESS;
      },
      path_filestat_get(dirFd, _flags, pathPtr, pathLen, outPtr) {
        const at = pathAt(dirFd, pathPtr, pathLen);
        if (at.err) { return at.err; }
        const found = fs.nodes.get(at.path);
        if (!found) { return ENOENT; }
        writeFilestat(outPtr, found);
        return ESUCCESS;
      },
      path_create_directory(dirFd, pathPtr, pathLen) {
        const at = pathAt(dirFd, pathPtr, pathLen);
        if (at.err) { return at.err; }
        if (fs.nodes.has(at.path)) { return EEXIST; }
        const parent = fs.nodes.get(parentOf(at.path));
        if (!parent || parent.kind !== "dir") { return ENOENT; }
        fs.nodes.set(at.path, fs.node("dir", null));
        return ESUCCESS;
      },
      path_remove_directory(dirFd, pathPtr, pathLen) {
        const at = pathAt(dirFd, pathPtr, pathLen);
        if (at.err) { return at.err; }
        if (at.path === "/") { return EINVAL; }
        const found = fs.nodes.get(at.path);
        if (!found) { return ENOENT; }
        if (found.kind !== "dir") { return ENOTDIR; }
        for (const key of fs.nodes.keys()) {
          if (key.startsWith(at.path + "/")) { return ENOTEMPTY; }
        }
        fs.nodes.delete(at.path);
        return ESUCCESS;
      },
      path_unlink_file(dirFd, pathPtr, pathLen) {
        const at = pathAt(dirFd, pathPtr, pathLen);
        if (at.err) { return at.err; }
        const found = fs.nodes.get(at.path);
        if (!found) { return ENOENT; }
        if (found.kind === "dir") { return EISDIR; }
        fs.nodes.delete(at.path);
        return ESUCCESS;
      },
      path_rename(oldFd, oldPtr, oldLen, newFd, newPtr, newLen) {
        const from = pathAt(oldFd, oldPtr, oldLen);
        const to = pathAt(newFd, newPtr, newLen);
        if (from.err || to.err) { return from.err || to.err; }
        const found = fs.nodes.get(from.path);
        if (!found) { return ENOENT; }
        const parent = fs.nodes.get(parentOf(to.path));
        if (!parent || parent.kind !== "dir") { return ENOENT; }
        if (from.path === to.path) { return ESUCCESS; }
        for (const [path, moved] of Array.from(fs.nodes)) {
          if (path === from.path || path.startsWith(from.path + "/")) {
            fs.nodes.delete(path);
            fs.nodes.set(to.path + path.slice(from.path.length), moved);
          }
        }
        return ESUCCESS;
      },
      path_symlink: () => ENOTSUP,
      path_readlink: () => EINVAL,
      poll_oneoff(subPtr, evtPtr, count, donePtr) {
        // every subscription is reported ready at once: nothing here blocks
        const v = view();
        const n = count >>> 0;
        for (let i = 0; i < n; i++) {
          const at = (evtPtr >>> 0) + i * 32;
          u8().fill(0, at, at + 32);
          v.setBigUint64(at, v.getBigUint64((subPtr >>> 0) + i * 48, true), true);
        }
        v.setUint32(donePtr >>> 0, n, true);
        return ESUCCESS;
      },
      proc_exit(code) {
        throw new ProcExit(code);
      },
      random_get(bufPtr, len) {
        // getRandomValues takes at most 64 KiB a call
        for (let at = 0; at < (len >>> 0); at += 65536) {
          const end = Math.min(len >>> 0, at + 65536);
          crypto.getRandomValues(u8().subarray((bufPtr >>> 0) + at, (bufPtr >>> 0) + end));
        }
        return ESUCCESS;
      },
      sched_yield: () => ESUCCESS,
    };

    const started = performance.now();
    const made = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    const instance = made.instance || made;
    memory = instance.exports.memory;
    let exitCode = 0;
    let trap = null;
    try {
      instance.exports._start();
    } catch (err) {
      if (err instanceof ProcExit) {
        exitCode = err.code;
      } else {
        trap = err && err.message ? err.message : String(err);
      }
    }
    return { exitCode, trap, ms: performance.now() - started };
  }

  // splits a shell-like argument line: whitespace separates, quotes group
  function splitArgs(raw) {
    const out = [];
    let cur = null;
    let quote = null;
    for (const c of String(raw || "")) {
      if (quote) {
        if (c === quote) { quote = null; } else { cur += c; }
      } else if (c === '"' || c === "'") {
        quote = c;
        cur = cur || "";
      } else if (/\s/.test(c)) {
        if (cur !== null) { out.push(cur); cur = null; }
      } else {
        cur = (cur || "") + c;
      }
    }
    if (cur !== null) { out.push(cur); }
    return out;
  }

  const api = { makeFs, runWasi, splitArgs, cleanPath };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    self.machWasi = api;
  }
})();
