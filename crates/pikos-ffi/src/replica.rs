//! Device sync's engine, for the Swift CloudKit adapter the phone and the Mac share.
//!
//! The adapter decides nothing: Apple's sync engine says when to send and what arrived, and these
//! calls build what goes out and merge what comes in. Records cross as flat maps of plain values,
//! the shape CloudKit stores, so the adapter copies fields across without reading them.

use std::collections::HashMap;

use pikos_replica::codec::FieldMap;
use pikos_replica::merge::Value;
use pikos_replica::{Hlc, RecordName};

use crate::workspace::{Workspace, WorkspaceError};

/// A record field's value, as CloudKit stores one. Absent fields are NULL.
#[derive(uniffi::Enum, Clone, Debug, PartialEq)]
pub enum SyncValue {
    Integer { value: i64 },
    Real { value: f64 },
    Text { value: String },
}

/// A record as a transport stores it: its name within the workspace's zone and its fields.
#[derive(uniffi::Record, Clone, Debug, PartialEq)]
pub struct SyncRecord {
    pub name: String,
    pub fields: HashMap<String, SyncValue>,
}

/// A record's name and the name it's stored under in CloudKit, which takes only ASCII and up to
/// 255 characters. The record carries its real name, so the stored one never has to be reversed.
#[derive(uniffi::Record, Clone, Debug, PartialEq)]
pub struct RecordAddress {
    pub name: String,
    pub store_name: String,
}

/// A record ready to send, with the clock it was built at, which `records_sent` takes back.
#[derive(uniffi::Record, Clone, Debug)]
pub struct BuiltRecord {
    pub record: SyncRecord,
    pub store_name: String,
    pub built_at: String,
    /// CloudKit's metadata for the record as last seen, from `save_system_fields`.
    pub system_fields: Option<Vec<u8>>,
}

/// CloudKit's metadata for a record, change tag included, to keep with the workspace.
#[derive(uniffi::Record, Clone, Debug)]
pub struct SystemFields {
    pub name: String,
    pub data: Vec<u8>,
}

/// A record the transport stored, with the clock it was built at.
#[derive(uniffi::Record, Clone, Debug)]
pub struct SentRecord {
    pub name: String,
    pub built_at: String,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq)]
pub struct SyncApplied {
    /// Records that changed something here.
    pub changed: u32,
    /// Records waiting for a parent or a newer Pikos.
    pub held: u32,
    /// Held images to fetch again, since only a fresh download can land them.
    pub refetch: Vec<RecordAddress>,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq)]
pub struct SyncState {
    pub workspace_id: String,
    /// The zone the workspace syncs into.
    pub zone: String,
    pub device_id: Option<String>,
    pub started: bool,
    pub paused: bool,
}

/// What the sync status line reads.
#[derive(uniffi::Record, Clone, Debug, PartialEq)]
pub struct SyncSummary {
    pub started: bool,
    pub paused: bool,
    /// Records waiting to send.
    pub pending: i64,
    /// Records waiting for a parent or a newer Pikos.
    pub held: i64,
    /// A newer Pikos wrote some of what arrived: the status line says to update.
    pub needs_update: bool,
    pub last_fetch_at: Option<String>,
}

/// What turning sync on does when the account already holds a workspace.
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq)]
pub enum JoinPlan {
    /// Nothing here was made by the person: clear it with `clear_for_join` and take the account's.
    Replace,
    /// Merge by id.
    Merge,
}

fn to_value(value: &SyncValue) -> Value {
    match value {
        SyncValue::Integer { value } => Value::Integer(*value),
        SyncValue::Real { value } => Value::Real(*value),
        SyncValue::Text { value } => Value::Text(value.clone()),
    }
}

fn from_map(map: &FieldMap) -> HashMap<String, SyncValue> {
    map.iter()
        .filter_map(|(key, value)| {
            let value = match value {
                Value::Null => return None,
                Value::Integer(v) => SyncValue::Integer { value: *v },
                Value::Real(v) => SyncValue::Real { value: *v },
                Value::Text(v) => SyncValue::Text { value: v.clone() },
            };
            Some((key.clone(), value))
        })
        .collect()
}

fn parse_name(name: &str) -> Result<RecordName, WorkspaceError> {
    name.parse().map_err(|e| WorkspaceError::InvalidInput {
        message: format!("{e}"),
    })
}

fn address(name: &RecordName) -> RecordAddress {
    RecordAddress {
        store_name: name.store_name(),
        name: name.to_string(),
    }
}

fn applied(applied: pikos_db::replica::apply::Applied) -> SyncApplied {
    SyncApplied {
        changed: applied.changed as u32,
        held: applied.held as u32,
        refetch: applied.refetch.iter().map(address).collect(),
    }
}

fn parse_clock(clock: &str) -> Result<Hlc, WorkspaceError> {
    clock.parse().map_err(|e| WorkspaceError::InvalidInput {
        message: format!("{e}"),
    })
}

fn state_of(meta: pikos_db::replica::ReplicaMeta) -> SyncState {
    SyncState {
        zone: pikos_replica::zone::zone_name(&meta.workspace_id),
        workspace_id: meta.workspace_id,
        device_id: meta.device_id,
        started: meta.started,
        paused: meta.paused,
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl Workspace {
    pub async fn sync_state(&self) -> Result<SyncState, WorkspaceError> {
        Ok(state_of(pikos_db::replica::meta(&self.pool).await?))
    }

    /// Starts recording changes to send. Store the returned device id in the keychain, this
    /// device only, straight away: `claim_device` reads it back.
    pub async fn start_sync(&self) -> Result<SyncState, WorkspaceError> {
        Ok(state_of(pikos_db::replica::start(&self.pool).await?))
    }

    pub async fn set_sync_paused(&self, paused: bool) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::set_paused(&self.pool, paused).await?)
    }

    pub async fn sync_held_for(&self) -> Result<Option<String>, WorkspaceError> {
        Ok(pikos_db::replica::held_for(&self.pool).await?)
    }

    pub async fn hold_sync(&self, reason: String) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::hold(&self.pool, &reason).await?)
    }

    /// Forget sync on this device: it joins again as a new one.
    pub async fn forget_sync(&self) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::forget(&self.pool).await?)
    }

    /// Checks the device id kept in the keychain against the workspace's, at every launch. Returns
    /// the id to keep there, a new one when the workspace was copied from another device.
    pub async fn claim_device(
        &self,
        keychain_device_id: Option<String>,
    ) -> Result<Option<String>, WorkspaceError> {
        Ok(pikos_db::replica::claim_device(&self.pool, keychain_device_id.as_deref()).await?)
    }

    pub async fn plan_join(&self) -> Result<JoinPlan, WorkspaceError> {
        Ok(match pikos_db::replica::plan_join(&self.pool).await? {
            pikos_db::replica::Join::Replace => JoinPlan::Replace,
            pikos_db::replica::Join::Merge => JoinPlan::Merge,
        })
    }

    pub async fn clear_for_join(&self, workspace_id: String) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::clear_for_join(&self.pool, &workspace_id).await?)
    }

    pub async fn adopt_workspace_id(&self, workspace_id: String) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::adopt_workspace_id(&self.pool, &workspace_id).await?)
    }

    /// Where this device keeps the workspace's images, so sync can send and receive them. Set it at
    /// every launch, before sync starts.
    pub async fn set_sync_assets_dir(&self, path: String) -> Result<(), WorkspaceError> {
        Ok(
            pikos_db::replica::images::set_assets_dir(&self.pool, std::path::Path::new(&path))
                .await?,
        )
    }

    /// The zone to sync in, given every zone the account holds; moves this workspace into it when
    /// another device's zone wins.
    pub async fn join_sync(&self, zones: Vec<String>) -> Result<String, WorkspaceError> {
        Ok(pikos_db::replica::join(&self.pool, &zones).await?)
    }

    /// The records waiting to send, oldest change first.
    pub async fn pending_records(&self, limit: u32) -> Result<Vec<RecordAddress>, WorkspaceError> {
        let names = pikos_db::replica::build::pending(&self.pool, i64::from(limit)).await?;
        Ok(names.iter().map(address).collect())
    }

    pub async fn build_records(
        &self,
        names: Vec<String>,
    ) -> Result<Vec<BuiltRecord>, WorkspaceError> {
        let names = names
            .iter()
            .map(|n| parse_name(n))
            .collect::<Result<Vec<_>, _>>()?;
        let built = pikos_db::replica::build::build(&self.pool, &names).await?;
        Ok(built
            .into_iter()
            .map(|b| BuiltRecord {
                store_name: b.name.store_name(),
                record: SyncRecord {
                    name: b.name.to_string(),
                    fields: from_map(&b.fields),
                },
                built_at: b.clock.to_string(),
                system_fields: b.system_fields,
            })
            .collect())
    }

    /// The transport stored these. Returns the names edited since they were built, to queue again.
    pub async fn records_sent(&self, sent: Vec<SentRecord>) -> Result<Vec<String>, WorkspaceError> {
        let sent = sent
            .iter()
            .map(|s| Ok((parse_name(&s.name)?, parse_clock(&s.built_at)?)))
            .collect::<Result<Vec<_>, WorkspaceError>>()?;
        let still = pikos_db::replica::build::sent(&self.pool, &sent).await?;
        Ok(still.into_iter().map(|name| name.to_string()).collect())
    }

    /// Merges fetched records, in one transaction. Save the transport's state only after this
    /// returns: CloudKit never hands back changes once its state has moved past them.
    pub async fn apply_records(
        &self,
        records: Vec<SyncRecord>,
    ) -> Result<SyncApplied, WorkspaceError> {
        let records = records
            .iter()
            .map(|r| {
                let map: FieldMap = r
                    .fields
                    .iter()
                    .map(|(k, v)| (k.clone(), to_value(v)))
                    .collect();
                Ok((parse_name(&r.name)?, map))
            })
            .collect::<Result<Vec<_>, WorkspaceError>>()?;
        Ok(applied(
            pikos_db::replica::apply::apply(&self.pool, &records).await?,
        ))
    }

    /// Keeps CloudKit's metadata for records it saved or fetched.
    pub async fn save_system_fields(
        &self,
        records: Vec<SystemFields>,
    ) -> Result<(), WorkspaceError> {
        let records = records
            .into_iter()
            .map(|r| Ok((parse_name(&r.name)?, r.data)))
            .collect::<Result<Vec<_>, WorkspaceError>>()?;
        Ok(pikos_db::replica::build::save_system_fields(&self.pool, &records).await?)
    }

    pub async fn engine_state(&self) -> Result<Option<Vec<u8>>, WorkspaceError> {
        Ok(pikos_db::replica::engine_state(&self.pool).await?)
    }

    pub async fn set_engine_state(&self, state: Vec<u8>) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::set_engine_state(&self.pool, &state).await?)
    }

    pub async fn fetch_finished(&self) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::fetch_finished(&self.pool).await?)
    }

    pub async fn sync_summary(&self) -> Result<SyncSummary, WorkspaceError> {
        let summary = pikos_db::replica::summary(&self.pool).await?;
        Ok(SyncSummary {
            started: summary.started,
            paused: summary.paused,
            pending: summary.pending,
            held: summary.held,
            needs_update: summary.needs_update,
            last_fetch_at: summary.last_fetch_at,
        })
    }

    /// Tries every held record again. Call after an update, which may read a format the old build
    /// couldn't.
    pub async fn retry_held_records(&self) -> Result<SyncApplied, WorkspaceError> {
        Ok(applied(
            pikos_db::replica::apply::retry_held(&self.pool).await?,
        ))
    }

    /// Forgets tombstones and holds past retention. Run now and then, such as on launch. Returns the
    /// records whose tombstones went, to delete from CloudKit as well.
    pub async fn expire_sync(&self) -> Result<Vec<RecordAddress>, WorkspaceError> {
        let forgotten = pikos_db::replica::expire(&self.pool).await?;
        Ok(forgotten.iter().map(address).collect())
    }
}

#[cfg(test)]
#[path = "replica_tests.rs"]
mod tests;
