/// FNV-1a 64-bit hex — deterministic across builds (std `DefaultHasher` isn't)
/// and dep-free. Change detection, not security.
pub fn fnv_hex(s: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}
