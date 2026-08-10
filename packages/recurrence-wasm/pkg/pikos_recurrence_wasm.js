let wasm;

let WASM_VECTOR_LEN = 0;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}
/**
 * @param {string} rrule
 * @param {string} anchor_start
 * @returns {string}
 */
export function alignWeeklyRuleToAnchor(rrule, anchor_start) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(anchor_start, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        wasm.alignWeeklyRuleToAnchor(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Human-readable label ("every week on Monday"), or undefined when the rule
 * can't be reduced to the phrased subset (callers fall back to the raw
 * string).
 * @param {string} rrule
 * @returns {string | undefined}
 */
export function rruleToLabel(rrule) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        wasm.rruleToLabel(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v2;
        if (r0 !== 0) {
            v2 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export_2(r0, r1 * 1, 1);
        }
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {string} base_end
 * @param {string} next_start
 * @returns {string | undefined}
 */
export function computeNextEnd(base_end, next_start) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(base_end, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(next_start, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        wasm.computeNextEnd(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v3;
        if (r0 !== 0) {
            v3 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export_2(r0, r1 * 1, 1);
        }
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Next occurrence's scheduledStart strictly after the day of `after`, or
 * undefined when the rule is exhausted or invalid.
 * @param {string} rrule
 * @param {string} scheduled_start
 * @param {string} after
 * @param {string} exdates_json
 * @returns {string | undefined}
 */
export function nextOccurrenceAfter(rrule, scheduled_start, after, exdates_json) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(scheduled_start, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(after, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(exdates_json, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len3 = WASM_VECTOR_LEN;
        wasm.nextOccurrenceAfter(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v5;
        if (r0 !== 0) {
            v5 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export_2(r0, r1 * 1, 1);
        }
        return v5;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Typed options as a JSON object (`{freq, interval, byweekday?,
 * byweekdayOrdinals?, bysetpos?, bymonthday?, bymonth?, wkst?, count?,
 * until?}`), or undefined when unparseable or the FREQ is unsupported.
 * @param {string} rrule
 * @returns {string | undefined}
 */
export function parseRruleOptions(rrule) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        wasm.parseRruleOptions(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v2;
        if (r0 !== 0) {
            v2 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export_2(r0, r1 * 1, 1);
        }
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Builds an RRULE string from a JSON options object. Returns undefined when
 * the JSON doesn't deserialize into valid options.
 * @param {string} options_json
 * @returns {string | undefined}
 */
export function buildRrule(options_json) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(options_json, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        wasm.buildRrule(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v2;
        if (r0 !== 0) {
            v2 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export_2(r0, r1 * 1, 1);
        }
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Compact byline label ("Weekly", "Every 2 weeks × 10"). Falls back to the
 * raw RRULE string on parse failure, mirroring the native helper.
 * @param {string} rrule
 * @returns {string}
 */
export function rruleToShortLabel(rrule) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        wasm.rruleToShortLabel(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_2(deferred2_0, deferred2_1, 1);
    }
}

/**
 * First `limit` occurrences anchored at `dtstart`, as a JSON array of local
 * ISO datetimes.
 * @param {string} rrule
 * @param {string} dtstart
 * @param {number} limit
 * @returns {string}
 */
export function listOccurrences(rrule, dtstart, limit) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(dtstart, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        wasm.listOccurrences(retptr, ptr0, len0, ptr1, len1, limit);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_2(deferred3_0, deferred3_1, 1);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}
/**
 * Occurrences of a rule within [rangeStart, rangeEnd) as a JSON array of
 * `{originalDate, scheduledStart, scheduledEnd}`.
 * @param {string} rrule
 * @param {string} scheduled_start
 * @param {string | null | undefined} scheduled_end
 * @param {string} range_start
 * @param {string} range_end
 * @param {string} exdates_json
 * @returns {string}
 */
export function expandRange(rrule, scheduled_start, scheduled_end, range_start, range_end, exdates_json) {
    let deferred7_0;
    let deferred7_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(scheduled_start, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(scheduled_end) ? 0 : passStringToWasm0(scheduled_end, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        var len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(range_start, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(range_end, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(exdates_json, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len5 = WASM_VECTOR_LEN;
        wasm.expandRange(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred7_0 = r0;
        deferred7_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_2(deferred7_0, deferred7_1, 1);
    }
}

/**
 * @param {string} rrule
 * @param {string} anchor
 * @returns {string}
 */
export function snapAnchorToRule(rrule, anchor) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(anchor, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        wasm.snapAnchorToRule(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * JSON array of YYYY-MM-DD strings strictly between `after` and `before`.
 * @param {string} rrule
 * @param {string} scheduled_start
 * @param {string} after
 * @param {string} before
 * @param {string} exdates_json
 * @returns {string}
 */
export function missedOccurrencesBetween(rrule, scheduled_start, after, before, exdates_json) {
    let deferred6_0;
    let deferred6_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(rrule, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(scheduled_start, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(after, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(before, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(exdates_json, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
        const len4 = WASM_VECTOR_LEN;
        wasm.missedOccurrencesBetween(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred6_0 = r0;
        deferred6_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export_2(deferred6_0, deferred6_1, 1);
    }
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;



    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('pikos_recurrence_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
