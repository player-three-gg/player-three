/**
 * Minimal reader for the WebAssembly binary format: just enough to enforce the policy ABI
 * (import list, defined memories and their limits, export kinds and signatures).
 * Callers must only pass bytes that `WebAssembly.compile` accepted; malformed input throws `WasmParseError`.
 */

export class WasmParseError extends Error {}

export type ValType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128' | 'ref';
export type ExternKind = 'func' | 'table' | 'memory' | 'global' | 'tag';

export interface FuncType {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}

export interface MemLimits {
  readonly min: number;
  readonly max: number | undefined;
  readonly shared: boolean;
  readonly is64: boolean;
  readonly customPageSize: boolean;
}

export interface WasmImport {
  readonly module: string;
  readonly name: string;
  readonly kind: ExternKind;
  /** Function imports only. */
  readonly typeIndex?: number;
  /** Memory imports only. */
  readonly limits?: MemLimits;
}

export interface WasmExport {
  readonly name: string;
  readonly kind: ExternKind;
  readonly index: number;
}

export interface WasmInfo {
  /** Index = type index; `null` for struct/array types. */
  readonly types: readonly (FuncType | null)[];
  readonly imports: readonly WasmImport[];
  /** Function index space (imports first) → type index. */
  readonly funcTypes: readonly number[];
  /** Memories defined by the module (not imported). */
  readonly memories: readonly MemLimits[];
  /** Tables defined by the module (not imported). */
  readonly tables: readonly MemLimits[];
  readonly exports: readonly WasmExport[];
  /** Initial value of global 0 when it is a defined `i32` initialised by a single `i32.const`. */
  readonly global0I32: number | undefined;
}

const KINDS: readonly ExternKind[] = ['func', 'table', 'memory', 'global', 'tag'];
const NUM_TYPES: Record<number, ValType> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128' };
const utf8 = new TextDecoder('utf-8', { fatal: false });

class Reader {
  pos: number;
  readonly end: number;
  readonly b: Uint8Array;
  constructor(b: Uint8Array, pos: number, end: number) {
    this.b = b;
    this.pos = pos;
    this.end = end;
  }
  byte(): number {
    if (this.pos >= this.end) throw new WasmParseError('unexpected end of section');
    return this.b[this.pos++]!;
  }
  /** Unsigned LEB128 up to 64 bits, returned as a JS number (precise below 2^53). */
  u(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      const x = this.byte();
      result += (x & 0x7f) * mul;
      if ((x & 0x80) === 0) return result;
      mul *= 128;
    }
    throw new WasmParseError('LEB128 too long');
  }
  /** Signed LEB128 (s32/s33). */
  s(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 5; i++) {
      const x = this.byte();
      result += (x & 0x7f) * mul;
      mul *= 128;
      if ((x & 0x80) === 0) return x & 0x40 ? result - mul : result;
    }
    throw new WasmParseError('signed LEB128 too long');
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.end) throw new WasmParseError('unexpected end of section');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  name(): string {
    return utf8.decode(this.bytes(this.u()));
  }
}

function heapType(r: Reader): void {
  r.s();
}

function valType(r: Reader): ValType {
  const b = r.byte();
  const num = NUM_TYPES[b];
  if (num) return num;
  if (b === 0x63 || b === 0x64) heapType(r);
  // Abbreviated reference types (funcref, externref, anyref, …) are single bytes.
  return 'ref';
}

function storageType(r: Reader): void {
  const b = r.b[r.pos];
  if (b === 0x78 || b === 0x77) r.pos++;
  else valType(r);
}

function limits(r: Reader): MemLimits {
  const flags = r.u();
  const min = r.u();
  const max = flags & 0x01 ? r.u() : undefined;
  const customPageSize = (flags & 0x08) !== 0;
  if (customPageSize) r.u();
  return { min, max, shared: (flags & 0x02) !== 0, is64: (flags & 0x04) !== 0, customPageSize };
}

function compType(r: Reader): FuncType | null {
  const form = r.byte();
  if (form === 0x60) {
    const params: ValType[] = [];
    for (let n = r.u(); n > 0; n--) params.push(valType(r));
    const results: ValType[] = [];
    for (let n = r.u(); n > 0; n--) results.push(valType(r));
    return { params, results };
  }
  if (form === 0x5f) {
    for (let n = r.u(); n > 0; n--) {
      storageType(r);
      r.byte();
    }
    return null;
  }
  if (form === 0x5e) {
    storageType(r);
    r.byte();
    return null;
  }
  throw new WasmParseError(`unknown composite type form 0x${form.toString(16)}`);
}

function subType(r: Reader): FuncType | null {
  const b = r.b[r.pos];
  if (b === 0x50 || b === 0x4f) {
    r.pos++;
    for (let n = r.u(); n > 0; n--) r.u();
  }
  return compType(r);
}

function tableType(r: Reader): MemLimits {
  valType(r);
  return limits(r);
}

/** Skips a table initialiser expression (`ref.null`, `ref.func`, `global.get`) through its `end`. */
function tableInit(r: Reader): void {
  for (;;) {
    const op = r.byte();
    if (op === 0x0b) return;
    if (op === 0xd0) heapType(r);
    else if (op === 0xd2 || op === 0x23) r.u();
    else throw new WasmParseError(`unsupported table initialiser opcode 0x${op.toString(16)}`);
  }
}

export function parseWasm(bytes: Uint8Array): WasmInfo {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new WasmParseError('not a WebAssembly module');
  }
  if (bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    throw new WasmParseError('not a core WebAssembly module (version 1)');
  }
  const types: (FuncType | null)[] = [];
  const imports: WasmImport[] = [];
  const funcTypes: number[] = [];
  const memories: MemLimits[] = [];
  const tables: MemLimits[] = [];
  const exports: WasmExport[] = [];
  let global0I32: number | undefined;
  let importedGlobals = 0;

  const top = new Reader(bytes, 8, bytes.length);
  while (top.pos < top.end) {
    const id = top.byte();
    const size = top.u();
    const end = top.pos + size;
    if (end > bytes.length) throw new WasmParseError('section overruns module');
    const r = new Reader(bytes, top.pos, end);
    switch (id) {
      case 1:
        for (let n = r.u(); n > 0; n--) {
          if (r.b[r.pos] === 0x4e) {
            r.pos++;
            for (let m = r.u(); m > 0; m--) types.push(subType(r));
          } else {
            types.push(subType(r));
          }
        }
        break;
      case 2:
        for (let n = r.u(); n > 0; n--) {
          const module = r.name();
          const name = r.name();
          const kindByte = r.byte();
          const kind = KINDS[kindByte];
          if (!kind) throw new WasmParseError(`unknown import kind ${kindByte}`);
          if (kind === 'func') {
            const typeIndex = r.u();
            funcTypes.push(typeIndex);
            imports.push({ module, name, kind, typeIndex });
          } else if (kind === 'table') {
            tableType(r);
            imports.push({ module, name, kind });
          } else if (kind === 'memory') {
            imports.push({ module, name, kind, limits: limits(r) });
          } else if (kind === 'global') {
            valType(r);
            r.byte();
            importedGlobals++;
            imports.push({ module, name, kind });
          } else {
            r.byte();
            r.u();
            imports.push({ module, name, kind });
          }
        }
        break;
      case 3:
        for (let n = r.u(); n > 0; n--) funcTypes.push(r.u());
        break;
      case 4:
        for (let n = r.u(); n > 0; n--) {
          if (r.b[r.pos] === 0x40) {
            r.pos++;
            r.byte();
            tables.push(tableType(r));
            tableInit(r);
          } else {
            tables.push(tableType(r));
          }
        }
        break;
      case 5:
        for (let n = r.u(); n > 0; n--) memories.push(limits(r));
        break;
      case 6:
        if (importedGlobals === 0 && r.u() > 0) {
          const t = valType(r);
          r.byte();
          if (t === 'i32' && r.byte() === 0x41) {
            const v = r.s();
            if (r.byte() === 0x0b) global0I32 = v;
          }
        }
        break;
      case 7:
        for (let n = r.u(); n > 0; n--) {
          const name = r.name();
          const kindByte = r.byte();
          const kind = KINDS[kindByte];
          if (!kind) throw new WasmParseError(`unknown export kind ${kindByte}`);
          exports.push({ name, kind, index: r.u() });
        }
        break;
      default:
        break;
    }
    top.pos = end;
  }
  return { types, imports, funcTypes, tables, memories, exports, global0I32 };
}

export function funcTypeOf(info: WasmInfo, funcIndex: number): FuncType | null {
  const t = info.funcTypes[funcIndex];
  return t === undefined ? null : (info.types[t] ?? null);
}

export function sameSignature(t: FuncType | null, params: readonly ValType[], results: readonly ValType[]): boolean {
  return (
    t !== null &&
    t.params.length === params.length &&
    t.results.length === results.length &&
    t.params.every((p, i) => p === params[i]) &&
    t.results.every((p, i) => p === results[i])
  );
}

export function formatSignature(params: readonly ValType[], results: readonly ValType[]): string {
  return `(${params.join(', ')}) -> ${results.length === 0 ? '()' : results.join(', ')}`;
}
