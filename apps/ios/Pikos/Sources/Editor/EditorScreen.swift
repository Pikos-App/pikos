import PikosCore
import PikosEditorBridge
import PikosSupport
import SwiftUI
import UIKit

/// A page, open for editing.
///
/// The one screen in the app that is not native. Everything around it — the
/// navigation bar, the formatting bar above the keyboard, the metadata strip,
/// the sheets — is SwiftUI; the document surface itself is the shared Tiptap
/// editor in a webview, so a page written here is byte-identical to one
/// written on the desktop.
///
/// The page's facts — its date, folder, tags, priority — are shown above the
/// document and changed from the menu in the corner, which is the list's long
/// press menu reached from the other direction. Before this an open page could
/// not be renamed, dated or filed without going back to the list and finding
/// it again, which on the desktop is the metadata header's whole job.
struct EditorScreen: View {
    let pageId: String

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss

    @State private var page: Page?
    @State private var loadFailed = false
    @State private var selection = EditorSelection()
    @State private var assetsURL: URL?
    @State private var coldLoadSeconds: TimeInterval?
    @State private var actions = PageActionState()
    @State private var isKeyboardVisible = false
    /// Owned here rather than by the editor view, which is a value type
    /// recreated on every update and so cannot hold a live reference.
    @State private var controller = EditorController()

    var body: some View {
        Group {
            if let page, let assetsURL {
                editor(page: page, assetsURL: assetsURL)
            } else if loadFailed {
                ContentUnavailableView(
                    "Page unavailable",
                    systemImage: "doc.questionmark",
                    description: Text("This page may have been deleted."))
            } else {
                ProgressView()
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        // A rename, a new date or a moved folder from the menu is a write
        // through the store, and the store bumps its version after each. The
        // facts are re-read so the title and the strip follow; the document is
        // not re-sent — the editor only loads when the page *id* changes, and
        // re-pushing content it already holds would fight the caret.
        .onChange(of: store.dataVersion) { _, _ in
            Task { await reloadFacts() }
        }
        // The list is not refreshed on every keystroke — see WorkspaceStore —
        // so it is refreshed once, here, when the editor goes away.
        .onDisappear { Task { await store.refresh() } }
        .pageActionSheets($actions)
    }

    @ViewBuilder
    private func editor(page: Page, assetsURL: URL) -> some View {
        let editable = store.canEdit(page)
        let facts = PageFacts(page)

        VStack(spacing: 0) {
            if !editable {
                // Refusing to save is not enough on its own: a user typing into
                // a surface that silently discards their work is worse than one
                // that tells them why it cannot.
                Label(
                    "This page was edited in a newer version of Pikos. Update to edit it.",
                    systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.yellow.opacity(0.2))
            }

            MetadataStrip(page: facts, actions: $actions)

            EditorWebView(
                pageId: page.id,
                documentJSON: page.content,
                assetRoot: assetsURL,
                controller: controller,
                colorScheme: colorScheme,
                accentColor: Brand.accentHex,
                // Every callback hops to the main actor explicitly. They are
                // invoked from WebKit delegate callbacks, and whether those are
                // main-actor-isolated depends on the SDK's audit state — hopping
                // is correct either way and costs nothing.
                onDocumentChanged: { pageId, json, plainText in
                    guard editable else { return }
                    Task { @MainActor in
                        await store.saveDocument(pageId: pageId, json: json, plainText: plainText)
                    }
                },
                onSelectionChanged: { marks, nodeType, isEmpty in
                    Task { @MainActor in
                        selection = EditorSelection(
                            marks: Set(marks), nodeType: nodeType, isEmpty: isEmpty)
                    }
                },
                onLinkTapped: { url in
                    // The webview never navigates; the app decides. That keeps a
                    // tapped link from replacing the editor with a web page.
                    Task { @MainActor in openURL(url) }
                },
                onReady: { duration in
                    Task { @MainActor in coldLoadSeconds = duration }
                }
            )
        }
        // The formatting bar sits in the safe area's bottom inset, which the
        // keyboard shrinks — so it rides up with the keyboard and goes away with
        // it. Not a `.keyboard` toolbar item: that attaches to the input
        // accessory of a SwiftUI text field, and a webview brings its own
        // responder and its own accessory view, so a toolbar placed there is
        // one nobody would ever see above this editor.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if editable && isKeyboardVisible {
                FormattingToolbar(selection: selection, controller: controller) {
                    controller.blur()
                }
                .background(.bar)
                .overlay(alignment: .top) { Divider() }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: isKeyboardVisible)
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)
        ) { _ in isKeyboardVisible = true }
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
        ) { _ in isKeyboardVisible = false }
        .navigationTitle(page.title.isEmpty ? "Untitled" : page.title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                FocusTimer(pageId: page.id)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    PageActionsMenu(page: facts, state: $actions) {
                        // The page is in the trash; there is nothing left to
                        // show. Back to wherever it was opened from.
                        dismiss()
                    }
                } label: {
                    Label("Page options", systemImage: "ellipsis.circle")
                }
            }
            #if DEBUG
            // M0's cold-load bar is < 300ms on iPhone 12-class hardware. Shown
            // in debug builds so the number is visible while measuring rather
            // than something to go looking for in a log.
            if let coldLoadSeconds {
                ToolbarItem(placement: .topBarTrailing) {
                    Text("\(Int(coldLoadSeconds * 1000))ms")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            #endif
        }
    }

    private func load() async {
        do {
            assetsURL = try WorkspaceLocation.assetsURL()
        } catch {
            loadFailed = true
            return
        }
        page = await store.page(id: pageId)
        loadFailed = page == nil
    }

    /// Re-read the page after a write from the menu.
    ///
    /// Only once it has loaded — the first load owns the failure state, and a
    /// version bump arriving mid-load must not flip the screen to "deleted"
    /// over a page that is fine.
    private func reloadFacts() async {
        guard page != nil, let latest = await store.page(id: pageId) else { return }
        page = latest
    }
}

/// What the caret is currently inside, as the editor last reported it.
struct EditorSelection: Equatable {
    var marks: Set<String> = []
    var nodeType: String = "paragraph"
    var isEmpty: Bool = true
}

/// The page's facts, above the document.
///
/// One line: when it is, where it is filed, how urgent, and what it is tagged.
/// Each chip opens the sheet that changes it, so the strip is the header and
/// the control at once — the desktop's metadata header, sized for a phone. It
/// draws nothing at all for a page in the Inbox with no date, priority or
/// tags: an empty strip would be a gap above every fresh note, and the menu
/// still offers all four.
private struct MetadataStrip: View {
    let page: PageFacts
    @Binding var actions: PageActionState

    @Environment(WorkspaceStore.self) private var store

    private var folder: Folder? {
        guard let id = page.folderId else { return nil }
        return store.folders.first { $0.id == id }
    }

    private var priority: PagePriority? { PagePriority(stored: page.priority) }

    private var hasAnything: Bool {
        page.scheduledStart != nil || folder != nil || priority != nil || !page.tags.isEmpty
    }

    var body: some View {
        if hasAnything {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    if let start = page.scheduledStart {
                        chip {
                            HStack(spacing: 4) {
                                if page.isRecurring {
                                    Image(systemName: "repeat")
                                }
                                ScheduleLabel(iso: start, isDone: page.isDone)
                            }
                        } action: {
                            // A repeating page's date belongs to its rule, so
                            // its chip opens the repeat instead; a calendar's
                            // page cannot be moved from here at all.
                            if page.scheduleLocked { return }
                            actions.sheet = page.isRecurring ? .repeatRule(page) : .schedule(page)
                        }
                    }
                    if let folder {
                        chip { FolderLabel(folder: folder) }
                    }
                    if let priority {
                        chip {
                            Label(priority.name, systemImage: "flag.fill")
                                .font(.caption)
                                .foregroundStyle(priority.color)
                        }
                    }
                    if !page.tags.isEmpty {
                        chip {
                            Label(page.tags.joined(separator: ", "), systemImage: "tag")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        } action: {
                            actions.sheet = .tags(page)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }
        }
    }

    /// A chip, tappable when there is something to open from it.
    @ViewBuilder
    private func chip<Content: View>(
        @ViewBuilder content: () -> Content, action: (() -> Void)? = nil
    ) -> some View {
        let inner = content()
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.quaternary, in: Capsule())
        if let action {
            Button(action: action) { inner }.buttonStyle(.plain)
        } else {
            inner
        }
    }
}
