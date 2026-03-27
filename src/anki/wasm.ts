// WASM loader for the Anki SM-2 scheduler.
// Inlines the wasm-bindgen glue (stripped of ES module syntax) and provides
// typed wrappers around the raw WASM functions.

import type { NormalState, SchedulerConfig, SchedulingStates } from './types';

// === WASM glue state (from wasm-pack output) ===
let cachedUint8ArrayMemory0: Uint8Array | null = null;
let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
const cachedTextEncoder = new TextEncoder();
let WASM_VECTOR_LEN = 0;
let wasm: any = null;

function getUint8ArrayMemory0(): Uint8Array {
  if (!cachedUint8ArrayMemory0 || cachedUint8ArrayMemory0.byteLength === 0)
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr: number, len: number): string {
  ptr = ptr >>> 0;
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function passStringToWasm0(arg: string, malloc: Function, realloc: Function): number {
  let len = arg.length;
  let ptr = (malloc(len, 1) as number) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7F) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) arg = arg.slice(offset);
    ptr = (realloc(ptr, len, len = offset + arg.length * 3, 1) as number) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written!;
    ptr = (realloc(ptr, len, offset, 1) as number) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}

function getImports(): WebAssembly.Imports {
  return {
    './anki_scheduler_bg.js': {
      __wbindgen_init_externref_table(): void {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      },
    },
  };
}

// === Public API ===

export function isInitialized(): boolean {
  return wasm !== null;
}

export async function loadWasm(url: string = '/wasm/anki_scheduler_bg.wasm'): Promise<void> {
  if (wasm) return;
  const response = await fetch(url);
  const bytes = await response.arrayBuffer();
  const imports = getImports();
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, imports);
  wasm = instance.exports;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  console.log(`[anki] WASM loaded (${bytes.byteLength} bytes)`);
}

export function nextStates(state: NormalState, config: SchedulerConfig): SchedulingStates | null {
  if (!wasm) return null;
  const stateJson = JSON.stringify(state);
  const configJson = JSON.stringify(config);
  let d0: number, d1: number;
  try {
    const p0 = passStringToWasm0(stateJson, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const l0 = WASM_VECTOR_LEN;
    const p1 = passStringToWasm0(configJson, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const l1 = WASM_VECTOR_LEN;
    const ret = wasm.next_states(p0, l0, p1, l1);
    d0 = ret[0]; d1 = ret[1];
    const resultJson = getStringFromWasm0(ret[0], ret[1]);
    const result = JSON.parse(resultJson) as SchedulingStates;
    if (result.error) {
      console.error('[anki] scheduler error:', result.error);
      return null;
    }
    return result;
  } finally {
    wasm.__wbindgen_free(d0!, d1!, 1);
  }
}

export function intervalSecs(state: NormalState, secsUntilRollover: number = 43200): number {
  if (!wasm) return 0;
  const stateJson = JSON.stringify(state);
  const p0 = passStringToWasm0(stateJson, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  return (wasm.interval_secs(p0, WASM_VECTOR_LEN, secsUntilRollover) as number) >>> 0;
}
