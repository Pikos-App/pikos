import PikosCore
import PikosEditorBridge
import SwiftUI

/// A page, open for editing.
///
/// The one screen in the app that is not native. Everything around it — the
/// navigation bar, the toolbar above the keyboard, the sheets — is SwiftUI; the
/// document surface itself is the shared Tiptap editor in a webview, so a page
/// written here is byte-identical to one written on the desktop.
struct EditorScreen: View {
    let pageId: String

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    @State private var page: Page?
    @State private var loadFailed = false
    @State private var selection = EditorSelection()
    @State private var assetsURL: URL?
    @State private var coldLoadSeconds: TimeInterval?

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
        // The list is not refreshed on every keystroke — see WorkspaceStore —
        // so it is refreshed once, here, when the editor goes away.
        .onDisappear { Task { await store.refresh() } }
    }

    @ViewBuilder
    private func editor(page: Page, assetsURL: URL) -> some View {
        let editable = store.canEdit(page)

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

            EditorWebView(
                pageId: page.id,
                documentJSON: page.content,
                assetRoot: assetsURL,
                colorScheme: colorScheme,
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
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .navigationTitle(page.title.isEmpty ? "Untitled" : page.title)
        .toolbar {
            if editable {
                ToolbarItemGroup(placement: .keyboard) {
                    FormattingToolbar(selection: selection)
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
}

/// What the caret is currently inside, as the editor last reported it.
struct EditorSelection: Equatable {
    var marks: Set<String> = []
    var nodeType: String = "paragraph"
    var isEmpty: Bool = true
}
