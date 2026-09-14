import Foundation
import WebKit

/// Whatever can carry a message into a live editor.
///
/// A protocol rather than a direct reference to `EditorWebView.Coordinator` for
/// two reasons. The coordinator lives inside a `UIViewRepresentable`, which
/// exists only where UIKit does — naming it here would make this file, and the
/// tests that cover it, iOS-only for no reason. And a controller that talks to
/// an interface can be driven by a test double, which is the only way the
/// "drop commands until the editor is ready" rule below gets covered at all.
@MainActor
protocol EditorMessageSink: AnyObject {
    /// Whether the editor has reported itself ready to receive messages.
    var isReady: Bool { get }
    func deliver(_ message: EditorBridge.Outgoing)
}

/// A handle for sending commands into a live editor.
///
/// `EditorWebView` is a value type recreated on every SwiftUI update, so it is
/// the wrong place to hold "the webview to talk to". The screen owns a
/// controller instead, hands it to the editor and to whatever drives it — a
/// formatting toolbar, a menu — and the controller forwards to whichever
/// webview is currently attached.
///
/// Commands are dropped, not queued, when no editor is attached. The only
/// caller is UI that is on screen because an editor is, so a queued command
/// would be one whose moment has passed by the time it could run.
@MainActor
public final class EditorController {
    private weak var sink: (any EditorMessageSink)?

    public init() {}

    /// True once the editor has reported itself ready.
    public var isReady: Bool { sink?.isReady ?? false }

    func attach(_ sink: any EditorMessageSink) {
        self.sink = sink
    }

    func detach() {
        sink = nil
    }

    /// Toggle an inline mark over the selection.
    ///
    /// With a collapsed caret the mark becomes pending and applies to whatever
    /// is typed next — which is how a toolbar is used on a phone, and why
    /// nothing appears to happen until a character arrives.
    public func toggleMark(_ mark: Mark) {
        send(.toggleMark(.init(mark: mark.rawValue)))
    }

    /// Toggle the block type of the selection.
    public func toggleBlock(_ block: Block) {
        send(.toggleBlock(.init(headingLevel: block.headingLevel, nodeType: block.nodeType)))
    }

    public func focus() {
        send(.focus(.init()))
    }

    /// Make the document read-only, or editable again.
    ///
    /// `EditorWebView` sends this itself from its `isEditable` property, so a
    /// screen normally has no reason to call it; it is public for the case
    /// where a host wants to lock the surface mid-session without rebuilding
    /// the view.
    public func setEditable(_ editable: Bool) {
        send(.setEditable(.init(editable: editable)))
    }

    public func blur() {
        send(.blur(.init()))
    }

    /// Insert an image the app has already written into the workspace.
    ///
    /// Takes the stored asset path, not a URL: the path is what goes into the
    /// document, and a resolved URL would only work on the device that made it.
    public func insertImage(assetPath: String) {
        send(.insertImage(.init(assetPath: assetPath)))
    }

    private func send(_ message: EditorBridge.Outgoing) {
        guard let sink, sink.isReady else { return }
        sink.deliver(message)
    }

    // MARK: - Vocabulary

    /// Marks the editor will toggle. Mirrors the allowlist on the webview side,
    /// which refuses anything it does not recognise.
    public enum Mark: String, CaseIterable, Sendable {
        case bold
        case italic
        case underline
        case strike
        case code
    }

    /// Block types the editor will toggle.
    public enum Block: Equatable, Sendable {
        case paragraph
        /// Levels outside 1–3 are clamped: the schema declares only those, and
        /// anything else would be dropped on the next parse — which reads to
        /// the user as the heading not sticking.
        case heading(level: Int)
        case bulletList
        case orderedList
        case taskList
        case blockquote
        case codeBlock

        var nodeType: String {
            switch self {
            case .paragraph: return "paragraph"
            case .heading: return "heading"
            case .bulletList: return "bulletList"
            case .orderedList: return "orderedList"
            case .taskList: return "taskList"
            case .blockquote: return "blockquote"
            case .codeBlock: return "codeBlock"
            }
        }

        var headingLevel: Int {
            if case .heading(let level) = self { return level }
            return 0
        }
    }
}
