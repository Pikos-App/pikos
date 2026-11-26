import Foundation
import WebKit

/// Whatever can carry a message into a live editor.
///
/// A protocol, not `EditorWebView.Coordinator`, which exists only where UIKit does
/// and would make this file and its tests iOS-only. It also lets a test double
/// cover the "drop commands until the editor is ready" rule.
@MainActor
protocol EditorMessageSink: AnyObject {
    var isReady: Bool { get }
    func deliver(_ message: EditorBridge.Outgoing)
}

/// A handle for sending commands into a live editor.
///
/// `EditorWebView` is a value type recreated on every SwiftUI update, so the
/// screen owns a controller that forwards to whichever webview is attached.
///
/// Commands are dropped, not queued, when no editor is attached: a queued one
/// would have outlived its moment by the time it could run.
@MainActor
public final class EditorController {
    private weak var sink: (any EditorMessageSink)?

    public init() {}

    public var isReady: Bool { sink?.isReady ?? false }

    func attach(_ sink: any EditorMessageSink) {
        self.sink = sink
    }

    func detach() {
        sink = nil
    }

    /// Toggle an inline mark over the selection.
    ///
    /// With a collapsed caret the mark is pending until the next character.
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
    /// `EditorWebView` sends this itself from `isEditable`; call it only to lock
    /// the surface mid-session without rebuilding the view.
    public func setEditable(_ editable: Bool) {
        send(.setEditable(.init(editable: editable)))
    }

    public func blur() {
        send(.blur(.init()))
    }

    /// Insert an image the app has already written into the workspace.
    ///
    /// Takes the stored asset path, not a URL, which would only work on the device that made it.
    public func insertImage(assetPath: String) {
        send(.insertImage(.init(assetPath: assetPath)))
    }

    /// Offer the editor a newer body of the open page, which it shows in place or refuses, and
    /// answers through `EditorWebView.onReloadAnswered`. False when no editor took it, so no
    /// answer will come.
    @discardableResult
    public func reload(pageId: String, doc: String, changesSeen: Int) -> Bool {
        send(.reload(.init(changesSeen: changesSeen, doc: doc, pageId: pageId)))
    }

    @discardableResult
    private func send(_ message: EditorBridge.Outgoing) -> Bool {
        guard let sink, sink.isReady else { return false }
        sink.deliver(message)
        return true
    }

    /// Mirrors the webview's allowlist, which refuses anything else.
    public enum Mark: String, CaseIterable, Sendable {
        case bold
        case italic
        case underline
        case strike
        case code
    }

    public enum Block: Equatable, Sendable {
        case paragraph
        /// Levels outside 1–3 are clamped: the schema declares only those, and
        /// anything else is dropped on the next parse, so the heading wouldn't stick.
        case heading(level: Int)
        case bulletList
        case orderedList
        case taskList
        case blockquote
        case codeBlock

        /// The block's wire name, which the host's toolbar compares with the node under the caret.
        public var nodeType: String {
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
