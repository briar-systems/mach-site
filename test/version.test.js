// run with: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const { MACH_VERSION, versionOf, latest } = require("../assets/version.js");

const BAKED = MACH_VERSION;

function fetchWith(body, ok = true) {
  return async () => ({ ok, json: async () => body });
}

test("the export is the baked value or the raw placeholder", () => {
  // a checkout carries the placeholder, and a deploy or ci checkout carries a real version
  assert.match(BAKED, /^(\d+\.\d+\.\d+|@MACH_VERSION@)$/);
});

test("a baked file carries a real version", { skip: BAKED === "@MACH_VERSION@" && "raw checkout" }, () => {
  assert.match(BAKED, /^\d+\.\d+\.\d+$/);
});

test("versionOf accepts only a plain vX.Y.Z tag", () => {
  assert.equal(versionOf({ tag_name: "v5.4.0" }), "5.4.0");
  assert.equal(versionOf({ tag_name: "v5.4.0-rc1" }), null);
  assert.equal(versionOf({ tag_name: "5.4.0" }), null);
  assert.equal(versionOf({ tag_name: "v5.4" }), null);
  assert.equal(versionOf({ tag_name: 540 }), null);
  assert.equal(versionOf({}), null);
  assert.equal(versionOf(null), null);
});

test("latest returns the live version on a good response", async () => {
  assert.equal(await latest(fetchWith({ tag_name: "v9.9.9" }), BAKED), "9.9.9");
});

test("latest falls back on a malformed tag", async () => {
  assert.equal(await latest(fetchWith({ tag_name: "nightly" }), BAKED), BAKED);
});

test("latest falls back on a non-ok response", async () => {
  assert.equal(await latest(fetchWith({ message: "rate limited" }, false), BAKED), BAKED);
});

test("latest falls back on a rejected fetch", async () => {
  assert.equal(await latest(async () => { throw new Error("offline"); }, BAKED), BAKED);
});

test("latest falls back on a fetch that throws synchronously", async () => {
  assert.equal(await latest(() => { throw new Error("no fetch"); }, BAKED), BAKED);
});

test("latest falls back on unparseable json", async () => {
  const bad = async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } });
  assert.equal(await latest(bad, BAKED), BAKED);
});

test("latest falls back when fetch is unavailable", async () => {
  assert.equal(await latest(null, BAKED), BAKED);
});
