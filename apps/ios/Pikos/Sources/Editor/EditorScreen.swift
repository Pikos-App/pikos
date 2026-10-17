import PhotosUI
import PikosCore
import PikosEditorBridge
import PikosSupport
import SwiftUI
import UIKit

/// A page, open for editing.
///
/// The document is the shared Tiptap editor in a webview, so a page written here is byte-identical
/// to one written on the desktop. Above it sits the desktop's page header, native: the title, the
/// one-sentence subtitle, and the byline of status, folder, date, priority and tags, each of which
/// changes itself. The header gives its height back while the document has the keyboard.
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
    @State private var isPickingPhoto = false
    @State private var pickedPhoto: PhotosPickerItem?
    @FocusState private var headerFocus: EditorHeader.Field?
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
                // A surface that silently discards typing is worse than one that says why it cannot save.
                Label(
                    "This page was edited in a newer version of Pikos. Update to edit it.",
                    systemImage: "exclamationmark.triangle")
                    .font(.pkBodySm)
                    .foregroundStyle(.textPrimary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.statusDueSoon.opacity(0.14))
            }

            if !isDocumentFocused {
                EditorHeader(page: page, actions: $actions, focus: $headerFocus)
                    // Otherwise the webview squeezes it, and at large text its lines overlap.
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            EditorWebView(
                pageId: page.id,
                documentJSON: page.content,
                assetRoot: assetsURL,
                controller: controller,
                colorScheme: colorScheme,
                accentColor: Brand.linkHex(dark: colorScheme == .dark),
                isEditable: editable,
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
                onImageRequested: {
                    Task { @MainActor in isPickingPhoto = true }
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
            if editable && isDocumentFocused {
                FormattingToolbar(
                    selection: selection,
                    controller: controller,
                    onInsertImage: { isPickingPhoto = true },
                    onDismissKeyboard: { controller.blur() }
                )
                .background(.surfaceSecondary)
                .overlay(alignment: .top) {
                    Rectangle().fill(.borderSecondary).frame(height: 1)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .background(.surfacePrimary)
        .animation(.snappy, value: isDocumentFocused)
        // The system picker runs out of process, so no photo-library
        // permission is asked for: the app only ever sees the one picture
        // chosen.
        .photosPicker(isPresented: $isPickingPhoto, selection: $pickedPhoto, matching: .images)
        .onChange(of: pickedPhoto) { _, item in
            guard let item else { return }
            pickedPhoto = nil
            Task { await insert(photo: item, into: assetsURL) }
        }
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)
        ) { _ in isKeyboardVisible = true }
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
        ) { _ in isKeyboardVisible = false }
        .navigationTitle(isDocumentFocused ? (page.title.isEmpty ? "Untitled" : page.title) : "")
        .toolbarBackground(.surfacePrimary, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                FocusTimer(pageId: page.id, title: page.title)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    PageActionsMenu(page: facts, state: $actions, showsRename: false) {
                        // The page is in the trash: back to wherever it was opened from.
                        dismiss()
                    }
                    #if DEBUG
                        if let coldLoadSeconds {
                            Divider()
                            Text("Editor loaded in \(Int(coldLoadSeconds * 1000)) ms")
                        }
                    #endif
                } label: {
                    Label("Page options", systemImage: "ellipsis")
                }
                .tint(.textSecondary)
            }
        }
    }

    /// The document has the keyboard, as opposed to the title or subtitle above it.
    private var isDocumentFocused: Bool {
        isKeyboardVisible && headerFocus == nil
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
        if page != nil { await store.markOpened(pageId: pageId) }
    }

    /// Write a picked photo into the workspace and put it in the document.
    ///
    /// The document stores `assets/<file>`, the form the desktop stores, so a
    /// page reads the same in both apps — never an absolute path, which would
    /// be wrong after a restore to a new device. JPEG, PNG and GIF are stored as they are;
    /// anything else — a HEIC from the camera roll, most often — is re-encoded
    /// as JPEG so it renders here and on the desktop.
    private func insert(photo item: PhotosPickerItem, into assets: URL) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let name: String
            let bytes: Data
            if let ext = AssetName.storableExtension(for: item.supportedContentTypes) {
                name = AssetName.fresh(extension: ext)
                bytes = data
            } else {
                guard let image = UIImage(data: data),
                    let jpeg = image.jpegData(compressionQuality: 0.85)
                else {
                    store.errorMessage = String(localized: "That image could not be read.")
                    return
                }
                name = AssetName.fresh(extension: "jpg")
                bytes = jpeg
            }
            try bytes.write(to: assets.appendingPathComponent(name), options: .atomic)
            controller.insertImage(assetPath: "assets/\(name)")
        } catch {
            store.errorMessage = String(localized: "The photo could not be added: \(error.localizedDescription)")
        }
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

