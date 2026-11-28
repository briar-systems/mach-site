# Types

Every value has a written type, and `nothing` converts without a [cast](#casts).

## Integers

```mach
val N: i64 = 5;
```

`i64` is the default. See [packs](functions.md#packs) and the [rules](../language/types.md#integers).

### Casts

```mach error operands `i32` and `i64` have different types
val M: i64 = 1i32 + N;
```

> **Note:** Nothing widens.
