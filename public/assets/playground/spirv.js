// reads a spir-v module two ways: as a listing, decoded instruction by
// instruction from the khronos grammar, and as glsl es 3.00, so webgl2 can
// draw the fragment stage of a module built for vulkan. the translation
// rebuilds the module's structured control flow from its merge instructions.
(function () {
  "use strict";

  const node = typeof module !== "undefined" && module.exports;
  const grammar = node ? require("./spirv-grammar.js") : self.machSpirvGrammar;

  const MAGIC = 0x07230203;

  // the opcodes the reader and the translator name
  const Op = {};
  for (const code of Object.keys(grammar.ops)) { Op[grammar.ops[code][0]] = Number(code); }

  const STORAGE = { UniformConstant: 0, Input: 1, Uniform: 2, Output: 3, Private: 6, Function: 7, PushConstant: 9, StorageBuffer: 12 };
  const DECORATION = { BuiltIn: 11, Location: 30, Offset: 35, ArrayStride: 6 };
  const BUILTIN = { FragCoord: 15, PointCoord: 16, FrontFacing: 17 };
  const FRAGMENT = 4;
  const ORIGIN_UPPER_LEFT = 7;

  function f32(bits) {
    return new Float32Array(new Uint32Array([bits]).buffer)[0];
  }

  // the shortest decimal that reads back as the same f32
  function floatText(x) {
    if (!Number.isFinite(x)) { return String(x); }
    for (let digits = 1; digits < 9; digits++) {
      const text = String(Number(x.toPrecision(digits)));
      if (Math.fround(Number(text)) === x) { return text; }
    }
    return String(x);
  }

  // a nul-terminated utf-8 string packed four bytes a word, and the index of
  // the word after it
  function readString(words, at) {
    const bytes = [];
    for (let i = at; i < words.length; i++) {
      for (let b = 0; b < 4; b++) {
        const c = (words[i] >>> (b * 8)) & 0xff;
        if (c === 0) { return { text: new TextDecoder().decode(new Uint8Array(bytes)), next: i + 1 }; }
        bytes.push(c);
      }
    }
    return { text: new TextDecoder().decode(new Uint8Array(bytes)), next: words.length };
  }

  // the module's header and its instructions, each { op, words } with words
  // holding the operands alone
  function read(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteLength < 20 || u8.byteLength % 4) { return { ok: false, error: "not a SPIR-V module: its size is not a whole number of words" }; }
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const words = new Uint32Array(u8.byteLength / 4);
    for (let i = 0; i < words.length; i++) { words[i] = dv.getUint32(i * 4, true); }
    if (words[0] !== MAGIC) { return { ok: false, error: "not a SPIR-V module: bad magic number" }; }
    const insts = [];
    for (let at = 5; at < words.length;) {
      const count = words[at] >>> 16;
      if (count === 0 || at + count > words.length) { return { ok: false, error: "truncated instruction at word " + at }; }
      insts.push({ op: words[at] & 0xffff, words: words.subarray(at + 1, at + count) });
      at += count;
    }
    return {
      ok: true,
      header: { major: (words[1] >>> 16) & 0xff, minor: (words[1] >>> 8) & 0xff, bound: words[3], bytes: u8.byteLength },
      insts,
    };
  }

  // the declarations a module makes outside its function bodies, and its
  // functions as blocks
  function analyze(bytes) {
    const mod = read(bytes);
    if (!mod.ok) { return mod; }
    const m = Object.assign(mod, {
      names: new Map(), types: new Map(), constants: new Map(), globals: new Map(),
      decorations: new Map(), memberDecorations: new Map(), valueTypes: new Map(),
      imports: new Map(), entryPoints: [], modes: [], functions: [],
    });
    const decorate = (map, key, kind, args) => {
      if (!map.has(key)) { map.set(key, new Map()); }
      map.get(key).set(kind, args);
    };
    let fn = null;
    let block = null;
    for (const inst of m.insts) {
      const w = inst.words;
      const shape = grammar.ops[inst.op] ? grammar.ops[inst.op][1] : "";
      if (shape.startsWith("T R")) { m.valueTypes.set(w[1], w[0]); }
      switch (inst.op) {
        case Op.Name: m.names.set(w[0], readString(w, 1).text); break;
        case Op.ExtInstImport: m.imports.set(w[0], readString(w, 1).text); break;
        case Op.EntryPoint: m.entryPoints.push({ model: w[0], id: w[1], name: readString(w, 2).text }); break;
        case Op.ExecutionMode: m.modes.push({ id: w[0], mode: w[1] }); break;
        case Op.Decorate: decorate(m.decorations, w[0], w[1], Array.from(w.subarray(2))); break;
        case Op.MemberDecorate: decorate(m.memberDecorations, w[0] + ":" + w[1], w[2], Array.from(w.subarray(3))); break;
        case Op.TypeVoid: m.types.set(w[0], { kind: "void" }); break;
        case Op.TypeBool: m.types.set(w[0], { kind: "bool" }); break;
        case Op.TypeInt: m.types.set(w[0], { kind: "int", width: w[1], signed: w[2] !== 0 }); break;
        case Op.TypeFloat: m.types.set(w[0], { kind: "float", width: w[1] }); break;
        case Op.TypeVector: m.types.set(w[0], { kind: "vector", elem: w[1], count: w[2] }); break;
        case Op.TypeMatrix: m.types.set(w[0], { kind: "matrix", elem: w[1], count: w[2] }); break;
        case Op.TypeArray: m.types.set(w[0], { kind: "array", elem: w[1], length: w[2] }); break;
        case Op.TypeRuntimeArray: m.types.set(w[0], { kind: "runtime_array", elem: w[1] }); break;
        case Op.TypeStruct: m.types.set(w[0], { kind: "struct", members: Array.from(w.subarray(1)) }); break;
        case Op.TypePointer: m.types.set(w[0], { kind: "pointer", storage: w[1], pointee: w[2] }); break;
        case Op.TypeFunction: m.types.set(w[0], { kind: "function", ret: w[1], params: Array.from(w.subarray(2)) }); break;
        case Op.TypeImage: m.types.set(w[0], { kind: "image" }); break;
        case Op.TypeSampler: m.types.set(w[0], { kind: "sampler" }); break;
        case Op.TypeSampledImage: m.types.set(w[0], { kind: "sampled_image" }); break;
        case Op.ConstantTrue: case Op.SpecConstantTrue: m.constants.set(w[1], { type: w[0], value: true }); break;
        case Op.ConstantFalse: case Op.SpecConstantFalse: m.constants.set(w[1], { type: w[0], value: false }); break;
        case Op.Constant: case Op.SpecConstant: m.constants.set(w[1], { type: w[0], bits: w[2], wide: w.length > 3 }); break;
        case Op.ConstantComposite: case Op.SpecConstantComposite: m.constants.set(w[1], { type: w[0], parts: Array.from(w.subarray(2)) }); break;
        case Op.ConstantNull: m.constants.set(w[1], { type: w[0], zero: true }); break;
        case Op.Undef: m.constants.set(w[1], { type: w[0], zero: true }); break;
        case Op.Function: fn = { id: w[1], ret: w[0], params: [], blocks: [] }; m.functions.push(fn); break;
        case Op.FunctionParameter: fn.params.push({ id: w[1], type: w[0] }); break;
        case Op.FunctionEnd: fn = null; block = null; break;
        case Op.Label: block = { id: w[0], insts: [], phis: [], merge: null }; fn.blocks.push(block); break;
        case Op.Variable:
          if (fn) { block.insts.push(inst); } else { m.globals.set(w[1], { type: w[0], storage: w[2], init: w.length > 3 ? w[3] : null }); }
          break;
        case Op.Phi: {
          const sources = new Map();
          for (let i = 2; i + 1 < w.length; i += 2) { sources.set(w[i + 1], w[i]); }
          block.phis.push({ id: w[1], type: w[0], sources });
          break;
        }
        case Op.LoopMerge: block.merge = { loop: true, merge: w[0], cont: w[1] }; break;
        case Op.SelectionMerge: block.merge = { loop: false, merge: w[0] }; break;
        default: if (block) { block.insts.push(inst); }
      }
    }
    return m;
  }

  // ---- the listing ----

  // names an id as spirv-dis would: its OpName, or one made from what it is
  function idNamer(m) {
    const taken = new Map();
    const names = new Map();
    const typeName = (id) => {
      const t = m.types.get(id);
      if (!t) { return null; }
      if (t.kind === "void" || t.kind === "bool") { return t.kind; }
      if (t.kind === "float") { return t.width === 32 ? "float" : t.width === 64 ? "double" : "half"; }
      if (t.kind === "int") { return (t.signed ? "" : "u") + (t.width === 32 ? "int" : t.width === 64 ? "long" : t.width === 16 ? "short" : "char"); }
      if (t.kind === "vector" && typeName(t.elem)) { return "v" + t.count + typeName(t.elem); }
      if (t.kind === "matrix" && typeName(t.elem)) { return "mat" + t.count + typeName(t.elem); }
      if (t.kind === "pointer" && nameOf(t.pointee)) { return "_ptr_" + storageName(t.storage) + "_" + nameOf(t.pointee); }
      if (t.kind === "struct") { return "_struct_" + id; }
      return null;
    };
    const storageName = (code) => {
      const found = grammar.enums.StorageClass.values[code];
      return Array.isArray(found) ? found[0] : found || String(code);
    };
    const constName = (id) => {
      const c = m.constants.get(id);
      const t = c && m.types.get(c.type);
      if (!c || !t || c.bits === undefined || c.wide || (t.kind !== "int" && t.kind !== "float")) { return null; }
      const value = t.kind === "float" ? floatText(f32(c.bits)) : t.signed ? c.bits | 0 : c.bits;
      return typeName(c.type) + "_" + String(value).replace(/-/g, "n").replace(/[^A-Za-z0-9]/g, "_");
    };
    function nameOf(id) {
      if (names.has(id)) { return names.get(id); }
      const named = m.names.get(id);
      let name = named ? named.replace(/[^A-Za-z0-9_]/g, "_") : typeName(id) || constName(id) || String(id);
      if (!name || (taken.has(name) && taken.get(name) !== id)) { name = (name || "") + "_" + id; }
      taken.set(name, id);
      names.set(id, name);
      return name;
    }
    return (id) => "%" + nameOf(id);
  }

  // the module as text, one instruction a line. every operand is decoded by
  // the grammar's kind for it, so an instruction this file never names still
  // reads correctly
  function disassemble(bytes) {
    const m = analyze(bytes);
    if (!m.ok) { return m; }
    const id = idNamer(m);

    function number(inst) {
      const t = m.types.get(inst.words[0]);
      const w = inst.words;
      if (t && t.kind === "float" && t.width === 32) { return floatText(f32(w[2])); }
      if (t && t.kind === "int" && t.width <= 32) { return String(t.signed ? w[2] | 0 : w[2]); }
      return Array.from(w.subarray(2)).map((x) => "0x" + x.toString(16)).join(" ");
    }

    // decodes operands of the given kinds from words[at..], returning the
    // text of each and where it stopped
    function decode(inst, kinds, at, out) {
      const w = inst.words;
      for (const spec of kinds.split(" ").filter(Boolean)) {
        const many = spec.endsWith("*");
        const optional = spec.endsWith("?");
        const kind = many || optional ? spec.slice(0, -1) : spec;
        do {
          if (at >= w.length) { break; }
          if (kind === "T" || kind === "R" || kind === "I") {
            out.push(id(w[at++]));
          } else if (kind === "n") {
            out.push(String(w[at++]));
          } else if (kind === "f") {
            out.push(floatText(f32(w[at++])));
          } else if (kind === "s") {
            const s = readString(w, at);
            out.push(JSON.stringify(s.text));
            at = s.next;
          } else if (kind === "c") {
            out.push(number(inst));
            at = w.length;
          } else if (kind === "x") {
            const set = m.imports.get(w[at - 1]);
            out.push((set === "GLSL.std.450" && grammar.std450[w[at]]) || String(w[at]));
            at++;
          } else if (kind === "o") {
            out.push(grammar.ops[w[at]] ? grammar.ops[w[at]][0] : String(w[at]));
            at++;
          } else if (kind[0] === "p" && kind.length === 3) {
            out.push(kind[1] === "I" ? id(w[at]) : String(w[at]));
            out.push(kind[2] === "I" ? id(w[at + 1]) : String(w[at + 1]));
            at += 2;
          } else {
            at = decodeEnum(inst, kind, at, out);
          }
        } while (many);
      }
      return at;
    }

    function decodeEnum(inst, kind, at, out) {
      const table = grammar.enums[kind];
      const value = inst.words[at++];
      if (!table) { out.push(String(value)); return at; }
      const entry = (v) => table.values[v];
      const name = (e) => (Array.isArray(e) ? e[0] : e);
      if (!table.bits) {
        const e = entry(value);
        out.push(e ? name(e) : String(value));
        return Array.isArray(e) ? decode(inst, e[1], at, out) : at;
      }
      const set = [];
      for (let bit = 0; bit < 32; bit++) {
        if (value & (1 << bit)) { set.push(entry((1 << bit) >>> 0) || String((1 << bit) >>> 0)); }
      }
      out.push(set.length ? set.map(name).join("|") : name(entry(0)) || "None");
      for (const e of set) {
        if (Array.isArray(e)) { at = decode(inst, e[1], at, out); }
      }
      return at;
    }

    const lines = ["; SPIR-V " + m.header.major + "." + m.header.minor + ", " + m.header.bytes + " bytes, id bound " + m.header.bound, ""];
    let inFunction = false;
    for (const inst of m.insts) {
      const entry = grammar.ops[inst.op];
      const args = [];
      let at = 0;
      let result = "";
      if (entry) {
        const kinds = entry[1].split(" ").filter(Boolean);
        // a result reads on the left, as `%id = OpName %type ...`
        if (kinds[0] === "T" && kinds[1] === "R") {
          result = id(inst.words[1]) + " = ";
          args.push(id(inst.words[0]));
          at = 2;
        } else if (kinds[0] === "R") {
          result = id(inst.words[0]) + " = ";
          at = 1;
        }
        at = decode(inst, kinds.slice(at).join(" "), at, args);
      }
      for (; at < inst.words.length; at++) { args.push(String(inst.words[at])); }
      if (inst.op === Op.Function) { lines.push(""); inFunction = true; }
      const indent = inFunction && inst.op !== Op.Function && inst.op !== Op.FunctionEnd && inst.op !== Op.Label ? "    " : "";
      lines.push(indent + result + "Op" + (entry ? entry[0] : inst.op) + (args.length ? " " + args.join(" ") : ""));
      if (inst.op === Op.FunctionEnd) { inFunction = false; }
    }
    const models = grammar.enums.ExecutionModel.values;
    return {
      ok: true,
      text: lines.join("\n") + "\n",
      version: m.header.major + "." + m.header.minor,
      stages: m.entryPoints.map((e) => ({ name: e.name, model: String(models[e.model] || e.model).toLowerCase() })),
    };
  }

  // ---- the translation ----

  // refuses a module the preview cannot draw, with the reason shown to the user
  function Unsupported(reason) {
    this.reason = reason;
  }
  function refuse(reason) {
    throw new Unsupported(reason);
  }

  const COMPONENTS = ["x", "y", "z", "w"];

  // GLSL.std.450 instructions as glsl es functions. `s` and `u` mark the ones
  // that read their integer operands as signed or unsigned
  const STD450 = {
    Round: "round", RoundEven: "roundEven", Trunc: "trunc", FAbs: "abs", SAbs: "s:abs", FSign: "sign", SSign: "s:sign",
    Floor: "floor", Ceil: "ceil", Fract: "fract", Radians: "radians", Degrees: "degrees",
    Sin: "sin", Cos: "cos", Tan: "tan", Asin: "asin", Acos: "acos", Atan: "atan",
    Sinh: "sinh", Cosh: "cosh", Tanh: "tanh", Asinh: "asinh", Acosh: "acosh", Atanh: "atanh", Atan2: "atan",
    Pow: "pow", Exp: "exp", Log: "log", Exp2: "exp2", Log2: "log2", Sqrt: "sqrt", InverseSqrt: "inversesqrt",
    Determinant: "determinant", MatrixInverse: "inverse", Modf: "modf",
    FMin: "min", UMin: "u:min", SMin: "s:min", FMax: "max", UMax: "u:max", SMax: "s:max",
    FClamp: "clamp", UClamp: "u:clamp", SClamp: "s:clamp", NMin: "min", NMax: "max", NClamp: "clamp",
    FMix: "mix", Step: "step", SmoothStep: "smoothstep",
    Length: "length", Distance: "distance", Cross: "cross", Normalize: "normalize",
    FaceForward: "faceforward", Reflect: "reflect", Refract: "refract",
  };

  // binary instructions as an operator, and how they read integer operands:
  // `r` as the result's type, `s` signed, `u` unsigned, `-` as they are
  const BINARY = {
    IAdd: ["+", "u"], ISub: ["-", "u"], IMul: ["*", "u"], UDiv: ["/", "u"], SDiv: ["/", "s"], UMod: ["%", "u"],
    FAdd: ["+", "-"], FSub: ["-", "-"], FMul: ["*", "-"], FDiv: ["/", "-"],
    VectorTimesScalar: ["*", "-"], MatrixTimesScalar: ["*", "-"], VectorTimesMatrix: ["*", "-"],
    MatrixTimesVector: ["*", "-"], MatrixTimesMatrix: ["*", "-"],
    BitwiseOr: ["|", "u"], BitwiseXor: ["^", "u"], BitwiseAnd: ["&", "u"],
    ShiftRightLogical: [">>", "u"], ShiftRightArithmetic: [">>", "s"], ShiftLeftLogical: ["<<", "u"],
  };

  // comparisons as [operator, vector function, how integer operands are read]
  const COMPARE = {
    IEqual: ["==", "equal", "u"], INotEqual: ["!=", "notEqual", "u"],
    UGreaterThan: [">", "greaterThan", "u"], SGreaterThan: [">", "greaterThan", "s"],
    UGreaterThanEqual: [">=", "greaterThanEqual", "u"], SGreaterThanEqual: [">=", "greaterThanEqual", "s"],
    ULessThan: ["<", "lessThan", "u"], SLessThan: ["<", "lessThan", "s"],
    ULessThanEqual: ["<=", "lessThanEqual", "u"], SLessThanEqual: ["<=", "lessThanEqual", "s"],
    FOrdEqual: ["==", "equal", "-"], FUnordEqual: ["==", "equal", "-"],
    FOrdNotEqual: ["!=", "notEqual", "-"], FUnordNotEqual: ["!=", "notEqual", "-"],
    FOrdLessThan: ["<", "lessThan", "-"], FUnordLessThan: ["<", "lessThan", "-"],
    FOrdGreaterThan: [">", "greaterThan", "-"], FUnordGreaterThan: [">", "greaterThan", "-"],
    FOrdLessThanEqual: ["<=", "lessThanEqual", "-"], FUnordLessThanEqual: ["<=", "lessThanEqual", "-"],
    FOrdGreaterThanEqual: [">=", "greaterThanEqual", "-"], FUnordGreaterThanEqual: [">=", "greaterThanEqual", "-"],
    LogicalEqual: ["==", "equal", "-"], LogicalNotEqual: ["!=", "notEqual", "-"],
  };

  const UNARY_CALL = {
    Any: "any", All: "all", IsNan: "isnan", IsInf: "isinf", Transpose: "transpose",
    DPdx: "dFdx", DPdy: "dFdy", Fwidth: "fwidth", DPdxFine: "dFdx", DPdyFine: "dFdy", FwidthFine: "fwidth",
    DPdxCoarse: "dFdx", DPdyCoarse: "dFdy", FwidthCoarse: "fwidth",
  };

  const IGNORED = new Set(["Nop", "Line", "NoLine"].map((n) => Op[n]));
  const opName = (code) => "Op" + (grammar.ops[code] ? grammar.ops[code][0] : code);

  // the fragment stage of a module as a glsl es 3.00 fragment shader, with the
  // uniform leaves the host must feed: { name, type, offset } per scalar or
  // vector of each uniform or push constant block
  function toGlsl(bytes) {
    const m = analyze(bytes);
    if (!m.ok) { return { ok: false, reason: m.error }; }
    try {
      return translate(m);
    } catch (err) {
      if (err instanceof Unsupported) { return { ok: false, reason: err.reason }; }
      throw err;
    }
  }

  function translate(m) {
    const entry = m.entryPoints.find((e) => e.model === FRAGMENT);
    if (!entry) { refuse("the module has no fragment stage, and the preview draws fragment stages"); }
    const type = (id) => m.types.get(id);
    const decoration = (id, kind) => (m.decorations.get(id) || new Map()).get(kind);

    // the scalar a type is made of
    function scalar(id) {
      const t = type(id);
      return t.kind === "vector" || t.kind === "matrix" ? scalar(t.elem) : t;
    }
    const isVector = (id) => type(id).kind === "vector";

    function typeName(id) {
      const t = type(id);
      if (!t) { refuse("an unknown type"); }
      if (t.kind === "void" || t.kind === "bool") { return t.kind; }
      if (t.kind === "float") { return t.width === 64 ? refuse("64-bit floats, which GLSL ES does not have") : "float"; }
      if (t.kind === "int") { return t.width === 64 ? refuse("64-bit integers, which GLSL ES does not have") : t.signed ? "int" : "uint"; }
      if (t.kind === "vector") { return { bool: "bvec", float: "vec", int: "ivec", uint: "uvec" }[typeName(t.elem)] + t.count; }
      if (t.kind === "matrix") { return "mat" + t.count + (type(t.elem).count === t.count ? "" : "x" + type(t.elem).count); }
      if (t.kind === "struct") { return "S" + id; }
      if (t.kind === "array") { return typeName(t.elem) + "[" + arrayLength(t) + "]"; }
      if (t.kind === "image" || t.kind === "sampler" || t.kind === "sampled_image") { return refuse("textures, which the preview does not bind"); }
      return refuse("a " + t.kind.replace("_", " ") + " type");
    }
    const arrayLength = (t) => m.constants.get(t.length).bits;

    // an integer type's name with the signedness an instruction reads it by
    function intName(id, signed) {
      const count = isVector(id) ? type(id).count : 0;
      return count ? (signed ? "ivec" : "uvec") + count : signed ? "int" : "uint";
    }

    function zero(id) {
      const t = type(id);
      if (t.kind === "bool") { return "false"; }
      if (t.kind === "float") { return "0.0"; }
      if (t.kind === "int") { return t.signed ? "0" : "0u"; }
      if (t.kind === "vector" || t.kind === "matrix") { return typeName(id) + "(" + zero(scalarId(id)) + ")"; }
      if (t.kind === "struct") { return typeName(id) + "(" + t.members.map(zero).join(", ") + ")"; }
      if (t.kind === "array") { return typeName(id) + "(" + new Array(arrayLength(t)).fill(zero(t.elem)).join(", ") + ")"; }
      return refuse("a value of a " + t.kind + " type");
    }
    function scalarId(id) {
      const t = type(id);
      return t.kind === "vector" || t.kind === "matrix" ? scalarId(t.elem) : id;
    }

    function literal(c) {
      const t = type(c.type);
      if (c.zero) { return zero(c.type); }
      if (c.parts) { return typeName(c.type) + "(" + c.parts.map(value).join(", ") + ")"; }
      if (t.kind === "bool") { return String(c.value); }
      if (t.kind === "int") { return t.signed ? "(" + (c.bits | 0) + ")" : c.bits + "u"; }
      const x = f32(c.bits);
      if (!Number.isFinite(x)) { return "uintBitsToFloat(" + c.bits + "u)"; }
      const text = floatText(x);
      return (/[.e]/.test(text) ? text : text + ".0").replace(/^-(.*)$/, "(-$1)");
    }

    // a value by id: a constant inline, anything else by the local holding it
    function value(id) {
      const c = m.constants.get(id);
      return c ? literal(c) : "v" + id;
    }
    const typeOf = (id) => m.valueTypes.get(id);

    // an integer value read as signed or unsigned, converted only when its
    // type says otherwise
    function as(id, how) {
      const t = scalar(typeOf(id));
      if (how === "-" || t.kind !== "int" || t.signed === (how === "s")) { return value(id); }
      return intName(typeOf(id), how === "s") + "(" + value(id) + ")";
    }

    // an expression whose integers are signed or unsigned, as a result type
    function to(typeId, expr, how) {
      const t = scalar(typeId);
      if (how === "-" || t.kind !== "int" || t.signed === (how === "s")) { return expr; }
      return typeName(typeId) + "(" + expr + ")";
    }

    // ---- interface ----

    const head = ["#version 300 es", "precision highp float;", "precision highp int;", ""];
    for (const [id, t] of m.types) {
      if (t.kind !== "struct") { continue; }
      head.push("struct S" + id + " {");
      t.members.forEach((member, i) => {
        const inner = type(member);
        // an array member is declared as glsl spells it, the length after the name
        head.push(inner.kind === "array"
          ? "  " + typeName(inner.elem) + " m" + i + "[" + arrayLength(inner) + "];"
          : "  " + typeName(member) + " m" + i + ";");
      });
      head.push("};");
    }

    // every scalar or vector under a uniform, with the byte offset the module
    // lays it out at
    const bindings = [];
    function bind(name, typeId, offset) {
      const t = type(typeId);
      if (t.kind === "struct") {
        t.members.forEach((member, i) => {
          const at = (m.memberDecorations.get(typeId + ":" + i) || new Map()).get(DECORATION.Offset);
          bind(name + ".m" + i, member, offset + (at ? at[0] : 0));
        });
      } else if (t.kind === "array") {
        const stride = decoration(typeId, DECORATION.ArrayStride);
        for (let i = 0; i < arrayLength(t); i++) { bind(name + "[" + i + "]", t.elem, offset + i * (stride ? stride[0] : 0)); }
      } else if (t.kind !== "matrix") {
        bindings.push({ name, type: typeName(typeId), offset });
      }
    }

    const pointers = new Map();
    const setup = [];
    const upperLeft = m.modes.some((x) => x.id === entry.id && x.mode === ORIGIN_UPPER_LEFT);
    const fragCoord = upperLeft
      ? "vec4(gl_FragCoord.x, pg_viewport.y - gl_FragCoord.y, gl_FragCoord.zw)"
      : "gl_FragCoord";
    let colour = false;
    head.push("uniform vec2 pg_viewport;");
    for (const [id, g] of m.globals) {
      const pointee = type(g.type).pointee;
      const name = typeName(pointee);
      const init = g.init !== null ? value(g.init) : null;
      if (g.storage === STORAGE.Uniform || g.storage === STORAGE.PushConstant) {
        head.push("uniform " + name + " u" + id + ";");
        bind("u" + id, pointee, 0);
        pointers.set(id, "u" + id);
        continue;
      }
      if (g.storage === STORAGE.UniformConstant) { refuse("textures, which the preview does not bind"); }
      if (g.storage === STORAGE.StorageBuffer) { refuse("a storage buffer, which WebGL2 does not have"); }
      // the one colour attachment is the canvas, at location 0
      const location = decoration(id, DECORATION.Location);
      if (g.storage === STORAGE.Output && location && location[0] === 0) {
        if (name !== "vec4") { refuse("an output at location 0 that is not an f32x4 colour"); }
        head.push("layout(location = 0) out vec4 g" + id + ";");
        colour = true;
      } else {
        head.push(name + " g" + id + ";");
      }
      pointers.set(id, "g" + id);
      if (g.storage === STORAGE.Input) {
        // a stage input is what the pipeline hands a fragment: the builtins
        // webgl has, and at location 0 the fragment's place in the canvas
        const builtin = decoration(id, DECORATION.BuiltIn);
        if (builtin && builtin[0] === BUILTIN.FragCoord) {
          setup.push("g" + id + " = " + fragCoord + ";");
        } else if (builtin && builtin[0] === BUILTIN.FrontFacing) {
          setup.push("g" + id + " = gl_FrontFacing;");
        } else if (builtin && builtin[0] === BUILTIN.PointCoord) {
          setup.push("g" + id + " = gl_PointCoord;");
        } else if (!builtin && location && location[0] === 0 && name === "vec2") {
          setup.push("g" + id + " = " + fragCoord + ".xy / pg_viewport;");
        } else {
          setup.push("g" + id + " = " + zero(pointee) + ";");
        }
      } else {
        setup.push("g" + id + " = " + (init || zero(pointee)) + ";");
      }
    }
    if (!colour) { refuse("a fragment stage with no `#[gpu.output(0)]` colour"); }

    // ---- functions ----

    function signature(fn) {
      const params = fn.params.map((p) => {
        if (type(p.type).kind === "pointer") { refuse("a function that takes a pointer"); }
        return typeName(p.type) + " v" + p.id;
      });
      return typeName(fn.ret) + " f" + fn.id + "(" + params.join(", ") + ")";
    }

    // a component, member or element of a composite, by one index
    function step(expr, typeId, index, constant) {
      const t = type(typeId);
      if (t.kind === "struct") { return { expr: expr + ".m" + constant, type: t.members[constant] }; }
      if (t.kind === "vector" && constant !== null) { return { expr: expr + "." + COMPONENTS[constant], type: t.elem }; }
      if (t.kind === "vector" || t.kind === "matrix" || t.kind === "array") { return { expr: expr + "[" + index + "]", type: t.elem }; }
      return refuse("an index into a " + t.kind);
    }

    function emitFunction(fn) {
      const blocks = new Map(fn.blocks.map((b) => [b.id, b]));
      const locals = [];
      const ptrs = new Map(pointers);
      const body = [];
      let depth = 1;
      const line = (text) => body.push("  ".repeat(depth) + text);
      // a block the walk emits twice declares its values once
      const declared = new Set();
      const declare = (id, typeId) => {
        if (!declared.has(id)) { locals.push("  " + typeName(typeId) + " v" + id + ";"); }
        declared.add(id);
      };

      for (const b of fn.blocks) {
        for (const phi of b.phis) {
          if (type(phi.type).kind === "pointer") { refuse("a pointer chosen at run time"); }
          declare(phi.id, phi.type);
          locals.push("  " + typeName(phi.type) + " p" + phi.id + ";");
        }
      }

      const set = (inst, expr) => {
        declare(inst.words[1], inst.words[0]);
        line("v" + inst.words[1] + " = " + expr + ";");
      };

      function pointer(id) {
        const found = ptrs.get(id);
        return found === undefined ? refuse("a pointer the preview cannot follow") : found;
      }

      function instruction(inst) {
        const w = inst.words;
        const name = grammar.ops[inst.op] ? grammar.ops[inst.op][0] : "";
        if (IGNORED.has(inst.op)) { return; }
        if (BINARY[name]) {
          const [op, how] = BINARY[name];
          // a shift count is read as it is: glsl takes either signedness there
          const right = name.startsWith("Shift") ? as(w[3], "u") : as(w[3], how);
          return set(inst, to(w[0], "(" + as(w[2], how) + " " + op + " " + right + ")", how));
        }
        if (COMPARE[name]) {
          const [op, call, how] = COMPARE[name];
          const a = as(w[2], how);
          const b = as(w[3], how);
          return set(inst, isVector(w[0]) ? call + "(" + a + ", " + b + ")" : "(" + a + " " + op + " " + b + ")");
        }
        if (UNARY_CALL[name]) { return set(inst, UNARY_CALL[name] + "(" + value(w[2]) + ")"); }
        switch (inst.op) {
          case Op.Variable: {
            const pointee = type(w[0]).pointee;
            if (!ptrs.has(w[1])) { locals.push("  " + typeName(pointee) + " l" + w[1] + ";"); }
            ptrs.set(w[1], "l" + w[1]);
            return line("l" + w[1] + " = " + (w.length > 3 ? value(w[3]) : zero(pointee)) + ";");
          }
          case Op.AccessChain: case Op.InBoundsAccessChain: {
            let at = { expr: pointer(w[2]), type: type(typeOf(w[2])).pointee };
            for (let i = 3; i < w.length; i++) {
              const c = m.constants.get(w[i]);
              at = step(at.expr, at.type, "int(" + value(w[i]) + ")", c && c.bits !== undefined ? c.bits : null);
            }
            ptrs.set(w[1], at.expr);
            return;
          }
          case Op.Load: return set(inst, pointer(w[2]));
          case Op.Store: return line(pointer(w[0]) + " = " + value(w[1]) + ";");
          case Op.CopyMemory: return line(pointer(w[0]) + " = " + pointer(w[1]) + ";");
          case Op.CopyObject: return set(inst, value(w[2]));
          case Op.CompositeConstruct: return set(inst, typeName(w[0]) + "(" + Array.from(w.subarray(2)).map(value).join(", ") + ")");
          case Op.CompositeExtract: {
            let at = { expr: value(w[2]), type: typeOf(w[2]) };
            for (let i = 3; i < w.length; i++) { at = step(at.expr, at.type, String(w[i]), w[i]); }
            return set(inst, at.expr);
          }
          case Op.CompositeInsert: {
            set(inst, value(w[3]));
            let at = { expr: "v" + w[1], type: w[0] };
            for (let i = 4; i < w.length; i++) { at = step(at.expr, at.type, String(w[i]), w[i]); }
            return line(at.expr + " = " + value(w[2]) + ";");
          }
          case Op.VectorExtractDynamic: return set(inst, value(w[2]) + "[int(" + value(w[3]) + ")]");
          case Op.VectorInsertDynamic:
            set(inst, value(w[2]));
            return line("v" + w[1] + "[int(" + value(w[4]) + ")] = " + value(w[3]) + ";");
          case Op.VectorShuffle: {
            const first = type(typeOf(w[2])).count;
            const lanes = Array.from(w.subarray(4)).map((lane) => {
              if (lane === 0xffffffff) { return zero(scalarId(w[0])); }
              return lane < first ? value(w[2]) + "." + COMPONENTS[lane] : value(w[3]) + "." + COMPONENTS[lane - first];
            });
            return set(inst, typeName(w[0]) + "(" + lanes.join(", ") + ")");
          }
          case Op.Select: {
            if (!isVector(typeOf(w[2]))) { return set(inst, "(" + value(w[2]) + " ? " + value(w[3]) + " : " + value(w[4]) + ")"); }
            const lanes = COMPONENTS.slice(0, type(w[0]).count).map((c) => value(w[2]) + "." + c + " ? " + value(w[3]) + "." + c + " : " + value(w[4]) + "." + c);
            return set(inst, typeName(w[0]) + "(" + lanes.join(", ") + ")");
          }
          case Op.Dot: return set(inst, "dot(" + value(w[2]) + ", " + value(w[3]) + ")");
          case Op.OuterProduct: return set(inst, "outerProduct(" + value(w[2]) + ", " + value(w[3]) + ")");
          case Op.FNegate: return set(inst, "(-" + value(w[2]) + ")");
          case Op.SNegate: return set(inst, to(w[0], "(-" + as(w[2], "s") + ")", "s"));
          case Op.Not: return set(inst, "(~" + value(w[2]) + ")");
          case Op.FRem: return set(inst, "(" + value(w[2]) + " - " + value(w[3]) + " * trunc(" + value(w[2]) + " / " + value(w[3]) + "))");
          case Op.FMod: return set(inst, "mod(" + value(w[2]) + ", " + value(w[3]) + ")");
          // glsl leaves % undefined for a negative operand, so the remainder
          // is taken from the truncating division
          case Op.SRem: return set(inst, to(w[0], "(" + as(w[2], "s") + " - " + as(w[3], "s") + " * (" + as(w[2], "s") + " / " + as(w[3], "s") + "))", "s"));
          case Op.LogicalNot: return set(inst, isVector(w[0]) ? "not(" + value(w[2]) + ")" : "(!" + value(w[2]) + ")");
          case Op.LogicalOr: case Op.LogicalAnd: {
            const or = inst.op === Op.LogicalOr;
            if (!isVector(w[0])) { return set(inst, "(" + value(w[2]) + (or ? " || " : " && ") + value(w[3]) + ")"); }
            const u = "uvec" + type(w[0]).count;
            return set(inst, typeName(w[0]) + "(" + u + "(" + value(w[2]) + ")" + (or ? " | " : " & ") + u + "(" + value(w[3]) + "))");
          }
          case Op.ConvertFToU: return set(inst, to(w[0], intName(w[0], false) + "(" + value(w[2]) + ")", "u"));
          case Op.ConvertFToS: return set(inst, to(w[0], intName(w[0], true) + "(" + value(w[2]) + ")", "s"));
          case Op.ConvertSToF: return set(inst, typeName(w[0]) + "(" + as(w[2], "s") + ")");
          case Op.ConvertUToF: return set(inst, typeName(w[0]) + "(" + as(w[2], "u") + ")");
          case Op.UConvert: case Op.SConvert: case Op.FConvert: return set(inst, typeName(w[0]) + "(" + value(w[2]) + ")");
          case Op.Bitcast: {
            const from = scalar(typeOf(w[2]));
            const dest = scalar(w[0]);
            if (from.kind === dest.kind) { return set(inst, typeName(w[0]) + "(" + value(w[2]) + ")"); }
            if (from.kind === "float") { return set(inst, (dest.signed ? "floatBitsToInt(" : "floatBitsToUint(") + value(w[2]) + ")"); }
            return set(inst, (from.signed ? "intBitsToFloat(" : "uintBitsToFloat(") + value(w[2]) + ")");
          }
          case Op.FunctionCall: {
            const call = "f" + w[2] + "(" + Array.from(w.subarray(3)).map(value).join(", ") + ")";
            return type(w[0]).kind === "void" ? line(call + ";") : set(inst, call);
          }
          case Op.ExtInst: {
            const lib = m.imports.get(w[2]) || "";
            if (lib.startsWith("NonSemantic.")) { return; }
            const called = lib === "GLSL.std.450" ? grammar.std450[w[3]] : null;
            const mapped = called && STD450[called];
            if (called === "Fma") { return set(inst, "(" + value(w[4]) + " * " + value(w[5]) + " + " + value(w[6]) + ")"); }
            if (!mapped) { return refuse((called || lib + " instruction " + w[3]) + ", which GLSL ES 3.00 has no function for"); }
            const how = mapped[1] === ":" ? mapped[0] : "-";
            const args = Array.from(w.subarray(4)).map((arg) => (type(typeOf(arg)).kind === "pointer" ? pointer(arg) : as(arg, how)));
            return set(inst, to(w[0], mapped.replace(/^.:/, "") + "(" + args.join(", ") + ")", how));
          }
          case Op.Kill: case Op.TerminateInvocation: return line("discard;");
          case Op.DemoteToHelperInvocation: return line("discard;");
          default: return refuse(opName(inst.op) + ", which the preview does not translate");
        }
      }

      // ---- control flow ----
      //
      // a walk emits blocks in order until one ends its path. `ctx.loop` is the
      // innermost loop being emitted and `ctx.stop` the merge blocks of the
      // selections around the walk, which an arm reaches by falling out

      // leaves `from` for `to`: the phi values the edge carries, then how the
      // transfer reads in structured code. returns the block to go on with, or
      // null when the path ends here
      function edge(from, to, ctx) {
        for (const phi of blocks.get(to).phis) {
          if (phi.sources.has(from)) { line("p" + phi.id + " = " + value(phi.sources.get(from)) + ";"); }
        }
        if (ctx.loop && to === ctx.loop.merge) { line("break;"); return null; }
        if (ctx.loop && to === ctx.loop.header) { line("continue;"); return null; }
        return ctx.stop.has(to) ? null : to;
      }

      function arm(from, to, ctx) {
        depth++;
        walk(edge(from, to, ctx), ctx);
        depth--;
      }

      // one block: its phis, its instructions and its terminator. returns the
      // block the walk continues at, or null
      function block(b, ctx) {
        for (const phi of b.phis) { line("v" + phi.id + " = p" + phi.id + ";"); }
        const last = b.insts[b.insts.length - 1];
        for (const inst of b.insts) {
          if (inst !== last) { instruction(inst); }
        }
        const w = last.words;
        switch (last.op) {
          case Op.Branch: return edge(b.id, w[0], ctx);
          case Op.BranchConditional: {
            if (w[1] === w[2]) { return edge(b.id, w[1], ctx); }
            const merge = b.merge && !b.merge.loop ? b.merge.merge : null;
            const inner = merge === null ? ctx : { loop: ctx.loop, stop: new Set(ctx.stop).add(merge) };
            line("if (" + value(w[0]) + ") {");
            arm(b.id, w[1], inner);
            line("} else {");
            arm(b.id, w[2], inner);
            line("}");
            return merge;
          }
          case Op.Return: line("return;"); return null;
          case Op.ReturnValue: line("return " + value(w[0]) + ";"); return null;
          case Op.Unreachable: return null;
          case Op.Kill: case Op.TerminateInvocation: line("discard;"); return null;
          case Op.Switch: return refuse("OpSwitch, which the preview does not translate");
          default: return refuse("a block ending in " + opName(last.op));
        }
      }

      function walk(start, ctx) {
        for (let at = start; at !== null;) {
          const b = blocks.get(at);
          if (b.merge && b.merge.loop) {
            // the continue block runs inline wherever the body reaches it, and
            // its branch back to the header is the loop's `continue`
            const inner = { loop: { header: b.id, merge: b.merge.merge }, stop: new Set() };
            line("for (;;) {");
            depth++;
            walk(block(b, inner), inner);
            depth--;
            line("}");
            at = b.merge.merge;
          } else {
            at = block(b, ctx);
          }
        }
      }

      const first = fn.blocks[0];
      walk(first.id, { loop: null, stop: new Set() });
      if (type(fn.ret).kind !== "void") { body.push("  return " + zero(fn.ret) + ";"); }
      return signature(fn) + " {\n" + locals.concat(body).join("\n") + "\n}";
    }

    const functions = m.functions.map(emitFunction);
    const glsl = head.concat(
      m.functions.map((fn) => signature(fn) + ";"),
      [""],
      functions,
      ["", "void main() {"],
      setup.map((s) => "  " + s),
      ["  f" + entry.id + "();", "}", ""],
    ).join("\n");
    return { ok: true, glsl, bindings, stage: entry.name };
  }

  const api = { MAGIC, disassemble, toGlsl };
  if (node) {
    module.exports = api;
  } else {
    self.machSpirv = api;
  }
})();
