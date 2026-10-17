//! Zones: where a workspace's records live in a transport's store, one per workspace.

/// The zone a workspace syncs into. Part of every stored record's address, so it never changes.
pub fn zone_name(workspace_id: &str) -> String {
    format!("ws-{workspace_id}")
}

/// The workspace id a zone holds, or None for a zone that isn't a workspace's.
pub fn workspace_of(zone: &str) -> Option<&str> {
    zone.strip_prefix("ws-").filter(|id| !id.is_empty())
}

/// Two devices that turned sync on before either saw the other each made a zone. Every device picks
/// the same one, the lowest workspace id, and the device whose zone lost merges into it and deletes
/// its own; nobody is asked and no two devices settle differently.
pub fn winner<'a>(zones: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    zones
        .into_iter()
        .filter(|zone| workspace_of(zone).is_some())
        .min()
}

#[cfg(test)]
mod tests {
    use super::{winner, workspace_of, zone_name};

    #[test]
    fn a_zone_names_its_workspace_and_back() {
        let zone = zone_name("1b2c");

        assert_eq!(zone, "ws-1b2c");
        assert_eq!(workspace_of(&zone), Some("1b2c"));
        assert_eq!(workspace_of("_defaultZone"), None);
        assert_eq!(workspace_of("ws-"), None);
    }

    #[test]
    fn every_device_picks_the_same_zone_whatever_order_it_lists_them_in() {
        let listed = ["ws-b", "_defaultZone", "ws-a", "ws-c"];
        let reversed: Vec<&str> = listed.iter().rev().copied().collect();

        assert_eq!(winner(listed), Some("ws-a"));
        assert_eq!(winner(reversed), Some("ws-a"));
        assert_eq!(winner(["_defaultZone"]), None);
    }
}
