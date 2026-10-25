import Foundation

/// The body of the page open in the editor, between the editor and the writer.
///
/// Every save carries the stored body the typing was done over, its base, so the writer merges an
/// edit made elsewhere since instead of overwriting it. Saves go one at a time, and typing that
/// arrives while one is out waits and goes as one save after it: two saves racing to the writer
/// would each be typed over a body the other had already replaced.
///
/// A newer stored body is offered to the editor when nothing typed is waiting: the merge a save
/// came back with, or a change from elsewhere found when the workspace says it changed. The editor
/// may still refuse it, holding typing that hasn't arrived here, so a body becomes the base only
/// once the editor answers that it showed it. Until then the base stays the body last typed, and
/// the next save merges again.
@MainActor
public final class OpenPageBody {
    /// Writes `typed` over `base` and returns the body stored after, or nil if nothing was written.
    public typealias Save = @MainActor (_ typed: String, _ base: String) async -> String?
    /// The body stored now, or nil if it can't be read.
    public typealias Read = @MainActor () async -> String?
    /// Hands a body to the editor, which answers through `answered(applied:)`; false when no editor
    /// took it, so no answer will come.
    public typealias Offer = @MainActor (_ body: String, _ changesSeen: Int) -> Bool

    private let save: Save
    private let read: Read
    private let offer: Offer

    private var base: String
    /// The body last known to be stored, to tell a change from elsewhere from what is on screen.
    private var known: String
    private var changesSeen = 0
    private var waiting: String?
    private var isCheckOwed = false
    /// Bodies the editor took and hasn't answered for, oldest first, as its answers come.
    private var offered: [String] = []
    private var work: Task<Void, Never>?

    public init(loaded: String, save: @escaping Save, read: @escaping Read, offer: @escaping Offer) {
        base = loaded
        known = loaded
        self.save = save
        self.read = read
        self.offer = offer
    }

    /// The editor sent the body as typed.
    public func typed(_ body: String) {
        changesSeen += 1
        waiting = body
        startWork()
    }

    /// The editor's answer to the oldest body it took.
    public func answered(applied: Bool) {
        guard !offered.isEmpty else { return }

        let body = offered.removeFirst()
        if applied { base = body }
    }

    /// The workspace changed; the stored body is read once nothing is waiting to be saved.
    public func storedMayHaveChanged() {
        isCheckOwed = true
        startWork()
    }

    /// Returns once nothing is being saved or read.
    public func settled() async {
        while let work { await work.value }
    }

    private func startWork() {
        guard work == nil else { return }

        work = Task {
            await drain()
            work = nil
        }
    }

    private func drain() async {
        while true {
            if let typed = waiting {
                waiting = nil
                await write(typed)
            } else if isCheckOwed {
                isCheckOwed = false
                await checkStored()
            } else {
                return
            }
        }
    }

    private func write(_ typed: String) async {
        let over = base
        base = typed
        guard let stored = await save(typed, over) else {
            base = over
            return
        }

        known = stored
        let isMerged = stored != typed
        let isTypedSince = waiting != nil
        if isMerged && !isTypedSince { show(stored) }
    }

    private func checkStored() async {
        let seen = changesSeen
        guard let stored = await read() else { return }

        let isTypedSince = changesSeen != seen
        let hasChanged = stored != known
        guard hasChanged, !isTypedSince else { return }

        known = stored
        show(stored)
    }

    private func show(_ body: String) {
        let isTaken = offer(body, changesSeen)
        if isTaken { offered.append(body) }
    }
}
