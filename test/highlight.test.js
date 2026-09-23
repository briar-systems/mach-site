// run with: node --test test/highlight.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenize, toml } = require("../assets/highlight.js");

test("toml marks table heads, keys and strings", () => {
  assert.equal(
    toml('[target.gpu]\nisa = "spirv"'),
    '<span class="toml-head">[target.gpu]</span>\n<span class="toml-key">isa</span> = <span class="str">"spirv"</span>',
  );
});

test("toml keeps a trailing comment out of the value", () => {
  assert.equal(
    toml('of  = "elf"   # loadable'),
    '<span class="toml-key">of</span>  = <span class="str">"elf"</span>   <span class="cmt"># loadable</span>',
  );
});

test("toml leaves a # inside a string alone", () => {
  assert.equal(
    toml('tag = "a#b"'),
    '<span class="toml-key">tag</span> = <span class="str">"a#b"</span>',
  );
});

test("the secret qualifier is marked apart from xor", () => {
  assert.match(tokenize("a: ^u64"), /<span class="ct">\^<\/span><span class="type">u64<\/span>/);
  assert.doesNotMatch(tokenize("ret a ^ b;"), /class="ct"/);
});
