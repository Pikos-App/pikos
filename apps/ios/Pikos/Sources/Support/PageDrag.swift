import Observation
import SwiftUI
import UniformTypeIdentifiers

/// A page being carried from the list to the day, from lift to drop.
///
/// Neither end of a drag is announced. The item is asked for when the long press begins, before
/// anything moves and even when the press only opens the menu; and a drop that lands nowhere gets
/// no callback, while the item provider outlives the drag. What is reliable is the stream of
/// updates: while a drag is anywhere over the app a drop target hears where it is several times a
/// second. So the day opens on the press, closes again if no update follows within a grace period
/// or once they go quiet, and reopens if a drag that outlasted the grace starts moving after all.
@MainActor
@Observable
final class PageDragSession {
    /// The page being carried; the day grows while this is set.
    private(set) var page: PageFacts?
    /// Minutes into today the finger is over, snapped; nil when it is not over the day.
    var hoverMinute: Int?

    /// The last page pressed, kept after the day closes so a slow drag can reopen it.
    @ObservationIgnored private(set) var candidate: PageFacts?
    @ObservationIgnored private var lastBeat = Date.distantPast
    @ObservationIgnored private var hasMoved = false
    @ObservationIgnored private var watch: Task<Void, Never>?

    static let prefix = "pikos-page:"
    /// Longer than the gap between two updates, shorter than anyone would notice the day waiting.
    private static let silence: TimeInterval = 0.4
    /// How long a press may hold the menu open before the day gives up waiting for a drag.
    private static let liftGrace: TimeInterval = 3

    func itemProvider(for page: PageFacts) -> NSItemProvider {
        candidate = page
        carry(page, moved: false)
        return NSItemProvider(object: "\(Self.prefix)\(page.id)" as NSString)
    }

    /// Called from every drop target's update while a drag is over it.
    func beat() {
        lastBeat = Date()
        hasMoved = true
        if page == nil, let candidate {
            carry(candidate, moved: true)
        }
    }

    #if DEBUG
        /// A drag frozen over the day, for a design screenshot; nothing ends it.
        func holdForScreenshot(_ page: PageFacts, minute: Int) {
            candidate = page
            self.page = page
            hoverMinute = minute
        }
    #endif

    /// Ends the drag and hands over its page, but only a page this app lifted: the carried text has
    /// to name the page the session holds.
    func land(_ info: DropInfo, then deliver: @escaping @MainActor (PageFacts) -> Void) -> Bool {
        guard let page, let provider = info.itemProviders(for: [.text]).first else { return false }
        end()
        _ = provider.loadObject(ofClass: NSString.self) { object, _ in
            let text = (object as? NSString).map(String.init) ?? ""
            Task { @MainActor in
                guard text == Self.prefix + page.id else { return }
                deliver(page)
            }
        }
        return true
    }

    /// The drag is over: dropped, or let go somewhere else after it moved.
    func end() {
        candidate = nil
        closeDay()
    }

    /// The press outlasted the grace without moving; keep the page in case it moves yet.
    private func closeDay() {
        watch?.cancel()
        watch = nil
        page = nil
        hoverMinute = nil
        hasMoved = false
    }

    private func carry(_ page: PageFacts, moved: Bool) {
        self.page = page
        hoverMinute = nil
        hasMoved = moved
        lastBeat = Date()
        watch?.cancel()
        watch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(150))
                guard let self, self.page != nil else { return }
                let quiet = Date().timeIntervalSince(self.lastBeat)
                if self.hasMoved, quiet > Self.silence {
                    self.end()
                    return
                }
                if !self.hasMoved, quiet > Self.liftGrace {
                    self.closeDay()
                    return
                }
            }
        }
    }
}

/// Covers the whole workspace so the session hears the drag wherever it is, and refuses the drop.
struct PageDragWatch: DropDelegate {
    let drag: PageDragSession

    func validateDrop(info: DropInfo) -> Bool {
        drag.candidate != nil
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        drag.beat()
        return DropProposal(operation: .cancel)
    }

    func performDrop(info: DropInfo) -> Bool {
        false
    }
}

/// The small card that follows the finger.
struct PageDragPreview: View {
    let title: String

    var body: some View {
        HStack(spacing: 10) {
            TaskCheckboxMark(isDone: false, size: 16)
            Text(title.isEmpty ? String(localized: "Untitled") : title)
                .font(.pkBodyMedium)
                .foregroundStyle(.textPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: 260, alignment: .leading)
        .background(.surfaceElevated, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(.borderPrimary, lineWidth: 0.5)
        )
    }
}
