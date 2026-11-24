//! What a writer makes up rather than reads: ids for new rows, and the current time.

use chrono::{DateTime, Utc};

/// A random v4 UUID, as text.
pub fn id() -> String {
    #[cfg(test)]
    if let Some(id) = replaying::id() {
        return id;
    }

    uuid::Uuid::new_v4().to_string()
}

/// The current instant.
pub fn now() -> DateTime<Utc> {
    #[cfg(test)]
    if let Some(now) = replaying::now() {
        return now;
    }

    Utc::now()
}

/// Until the returned guard drops, ids made on this thread follow `seed` and the time is `clock`'s
/// milliseconds. For a test that has to replay exactly: an id names a synced record, and a store
/// hands records over in name order; a timestamp is a synced value, and a tie between two writes
/// stamped with one replica clock goes to the larger value. Either one left random changes which
/// edit wins, and a seed stops reproducing its run.
#[cfg(test)]
pub(crate) fn replay(
    seed: u64,
    clock: &'static std::sync::atomic::AtomicU64,
) -> replaying::Replaying {
    replaying::start(seed, clock)
}

#[cfg(test)]
pub(crate) mod replaying {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};

    use chrono::{DateTime, Utc};

    thread_local! {
        static SEED: Cell<Option<u64>> = const { Cell::new(None) };
        static CLOCK: Cell<Option<&'static AtomicU64>> = const { Cell::new(None) };
    }

    pub(crate) struct Replaying;

    impl Drop for Replaying {
        fn drop(&mut self) {
            SEED.set(None);
            CLOCK.set(None);
        }
    }

    pub(super) fn start(seed: u64, clock: &'static AtomicU64) -> Replaying {
        SEED.set(Some(seed));
        CLOCK.set(Some(clock));
        Replaying
    }

    pub(super) fn id() -> Option<String> {
        let state = SEED.get()?;
        let (high, state) = splitmix64(state);
        let (low, state) = splitmix64(state);
        SEED.set(Some(state));

        let bytes = (u128::from(high) << 64 | u128::from(low)).to_le_bytes();

        Some(
            uuid::Builder::from_random_bytes(bytes)
                .into_uuid()
                .to_string(),
        )
    }

    pub(super) fn now() -> Option<DateTime<Utc>> {
        let ms = CLOCK.get()?.load(Ordering::SeqCst);

        DateTime::from_timestamp_millis(ms as i64)
    }

    fn splitmix64(state: u64) -> (u64, u64) {
        let state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);

        (z ^ (z >> 31), state)
    }
}
