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

/// A record ready to send, with the clock it was built at, which `records_sent` takes back.
#[derive(uniffi::Record, Clone, Debug)]
pub struct BuiltRecord {
    pub record: SyncRecord,
    pub built_at: String,
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

    /// Names of the records waiting to send, oldest change first.
    pub async fn pending_records(&self, limit: u32) -> Result<Vec<String>, WorkspaceError> {
        let names = pikos_db::replica::build::pending(&self.pool, i64::from(limit)).await?;
        Ok(names.into_iter().map(|name| name.to_string()).collect())
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
                record: SyncRecord {
                    name: b.name.to_string(),
                    fields: from_map(&b.fields),
                },
                built_at: b.clock.to_string(),
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
        let applied = pikos_db::replica::apply::apply(&self.pool, &records).await?;
        Ok(SyncApplied {
            changed: applied.changed as u32,
            held: applied.held as u32,
        })
    }

    pub async fn engine_state(&self) -> Result<Option<Vec<u8>>, WorkspaceError> {
        Ok(pikos_db::replica::engine_state(&self.pool).await?)
    }

    pub async fn set_engine_state(&self, state: Vec<u8>) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::set_engine_state(&self.pool, &state).await?)
    }

    /// Forgets tombstones and holds past retention. Run now and then, such as on launch.
    pub async fn expire_sync(&self) -> Result<(), WorkspaceError> {
        Ok(pikos_db::replica::expire(&self.pool).await?)
    }
}

#[cfg(test)]
#[path = "replica_tests.rs"]
mod tests;
