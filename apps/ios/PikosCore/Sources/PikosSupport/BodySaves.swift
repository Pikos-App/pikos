import PikosCore

/// One open page's body saves, each checked against the body as last stored, so an edit another
/// device made meanwhile is merged rather than written over.
///
/// One save runs at a time and only the latest document waits behind it, since an older one would
/// only be overwritten. A refused save drops the waiting document as well: it was typed over the
/// same stale body, and the editor reports its whole document again once it has merged.
@MainActor
public final class BodySaves {
    /// Saves `content` if the stored body is still at `loadedClock`; nil when the save failed.
    public typealias Save = (_ content: String, _ loadedClock: String?) async -> BodySave?
    /// The body moved on from `base` to `stored`; the editor merges onto `stored` and reports again.
    public typealias Moved = (_ base: String, _ stored: String) -> Void

    private var stored: String
    private var clock: String?
    private var waiting: String?
    private var isSaving = false
    private let saveBody: Save
    private let moved: Moved

    public init(stored: String, clock: String?, save: @escaping Save, moved: @escaping Moved) {
        self.stored = stored
        self.clock = clock
        self.saveBody = save
        self.moved = moved
    }

    public func save(_ content: String) async {
        waiting = content
        guard !isSaving else { return }

        isSaving = true
        defer { isSaving = false }
        while let next = waiting {
            waiting = nil
            switch await saveBody(next, clock) {
            case .saved(let clock):
                stored = next
                self.clock = clock
            case .moved(let content, let clock):
                let base = stored
                stored = content
                self.clock = clock
                waiting = nil
                moved(base, content)
                return
            case nil:
                return
            }
        }
    }
}
