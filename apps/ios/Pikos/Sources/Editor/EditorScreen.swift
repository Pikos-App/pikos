import PhotosUI
import PikosCore
import PikosEditorBridge
import PikosSupport
import SwiftUI
import UIKit
import os

/// A page, open for editing.
///
/// The document is the shared Tiptap editor in a webview, so a page written here is byte-identical
/// to one written on the desktop. The native header above it gives its height back while the
/// document has the keyboard or a focus session runs, and returns when the bar's title is tapped.
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
    @State private var typing = TypingTimes()
    @State private var actions = PageActionState()
    @State private var isKeyboardVisible = false
    /// The header asked back by tapping the bar's title. Cleared when the title and subtitle let go
    /// of the keyboard, the keyboard goes, or a focus session starts or stops.
    @State private var isHeaderRevealed = false
    @State private var focusStartedAt: Date?
    @State private var isPickingPhoto = false
    @State private var pickedPhoto: PhotosPickerItem?
    @FocusState private var headerFocus: EditorHeader.Field?
    /// Owned here rather than by the editor view, which is a value type
    /// recreated on every update and so cannot hold a live reference.
    @State private var controller = EditorController()
    @State private var openBody: OpenPageBody?
    @State private var pageWidth: CGFloat = 0

    /// The width kept clear on each side of the bar's title, enough for a running focus timer and
    /// the page menu. The bar never shrinks its centre item, so without a cap a long title runs
    /// off both edges. The cap goes on the button's label, since the bar ignores a frame set on
    /// the button itself.
    private static let barSideRoom: CGFloat = 130

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
        // The store bumps its version after every write and every sync that lands. Facts are
        // re-read so the title and strip follow, and a body changed elsewhere is offered to the
        // editor once nothing typed is waiting to be saved.
        .onChange(of: store.dataVersion) { _, _ in
            Task { await reloadFacts() }
            openBody?.storedMayHaveChanged()
        }
        // The list is not refreshed per keystroke (see WorkspaceStore), so once, on the way out.
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

            if !isHeaderHidden {
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
                // Every callback hops to the main actor explicitly: whether WebKit's delegate
                // callbacks are main-actor-isolated depends on the SDK, and hopping is correct
                // either way.
                onDocumentChanged: { _, json, _ in
                    guard editable else { return }
                    Task { @MainActor in openBody?.typed(json) }
                },
                onSelectionChanged: { marks, nodeType, isEmpty in
                    Task { @MainActor in
                        selection = EditorSelection(
                            marks: Set(marks), nodeType: nodeType, isEmpty: isEmpty)
                    }
                },
                onLinkTapped: { url in
                    // The webview never navigates; the app decides, so a tapped link cannot
                    // replace the editor with a web page.
                    Task { @MainActor in openURL(url) }
                },
                onImageRequested: {
                    Task { @MainActor in isPickingPhoto = true }
                },
                onReady: { duration in
                    Task { @MainActor in coldLoadSeconds = duration }
                },
                onInputTiming: { count, median, worst in
                    Task { @MainActor in typing.add(count: count, medianMs: median, worstMs: worst) }
                },
                onReloadAnswered: { _, applied in
                    Task { @MainActor in openBody?.answered(applied: applied) }
                }
            )
        }
        // The formatting bar sits in the safe area's bottom inset, which the keyboard shrinks, so it
        // rides with the keyboard. Not a `.keyboard` toolbar item: that attaches to a SwiftUI text
        // field's input accessory, and the webview brings its own responder and accessory view.
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
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { pageWidth = $0 }
        .animation(.snappy, value: isDocumentFocused)
        .animation(.snappy, value: isHeaderHidden)
        // The system picker runs out of process, so no photo-library permission is asked for.
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
        ) { _ in
            isKeyboardVisible = false
            isHeaderRevealed = false
        }
        .onChange(of: focusStartedAt == nil) { _, _ in isHeaderRevealed = false }
        .onChange(of: headerFocus) { _, field in
            if field == nil { isHeaderRevealed = false }
        }
        .toolbarBackground(.surfacePrimary, for: .navigationBar)
        .toolbar {
            if isHeaderHidden {
                ToolbarItem(placement: .principal) {
                    Button(action: editTitle) {
                        Text(page.title.isEmpty ? "Untitled" : page.title)
                            .lineLimit(1)
                            .frame(maxWidth: max(0, pageWidth - 2 * Self.barSideRoom))
                    }
                    .font(.headline)
                    .foregroundStyle(.textPrimary)
                    .accessibilityHint("Shows the header and edits the title")
                }
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
                        if typing.count > 0 {
                            Text(typing.summary)
                        }
                    #endif
                } label: {
                    Label("Page options", systemImage: "ellipsis")
                }
                .tint(.textSecondary)
            }
        }
        .modifier(FocusTimer(pageId: page.id, title: page.title, startedAt: $focusStartedAt))
    }

    private var isDocumentFocused: Bool {
        isKeyboardVisible && headerFocus == nil
    }

    private var isHeaderHidden: Bool {
        let isFocusing = focusStartedAt != nil
        let isEditingHeader = isKeyboardVisible && headerFocus != nil

        return (isDocumentFocused || (isFocusing && !isEditingHeader)) && !isHeaderRevealed
    }

    /// The focus moves on the next turn: the title field only exists once the header is drawn, and
    /// focus set on a field that isn't there yet is dropped.
    private func editTitle() {
        isHeaderRevealed = true
        Task { @MainActor in headerFocus = .title }
    }

    private static let log = Logger(subsystem: "app.pikos", category: "editor")

    private func load() async {
        do {
            assetsURL = try WorkspaceLocation.assetsURL()
        } catch {
            Self.log.error(
                "opening \(pageId, privacy: .public) failed, the images folder is unreachable: \(FailureText.kind(error), privacy: .public)"
            )
            loadFailed = true
            return
        }
        page = await store.page(id: pageId)
        loadFailed = page == nil
        guard let page else { return }

        openBody = makeOpenBody(loaded: page.content)
        await store.markOpened(pageId: pageId)
    }

    private func makeOpenBody(loaded: String) -> OpenPageBody {
        let (store, controller, pageId) = (store, controller, pageId)
        return OpenPageBody(
            loaded: loaded,
            save: { typed, base in await store.saveDocument(pageId: pageId, json: typed, base: base) },
            read: { await store.page(id: pageId)?.content },
            offer: { body, changesSeen in
                controller.reload(pageId: pageId, doc: body, changesSeen: changesSeen)
            })
    }

    /// Write a picked photo into the workspace and put it in the document.
    ///
    /// The document stores `assets/<file>`, the form the desktop stores, never an absolute path,
    /// which would be wrong after a restore to a new device. JPEG, PNG and GIF are stored as they
    /// are; anything else, most often a HEIC, is re-encoded as JPEG so it renders on both apps.
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
                    Self.log.error("a picked photo for \(pageId, privacy: .public) didn't decode: \(item.supportedContentTypes.map(\.identifier), privacy: .public)")
                    store.errorMessage = String(localized: "That image could not be read.")
                    return
                }
                name = AssetName.fresh(extension: "jpg")
                bytes = jpeg
            }
            try bytes.write(to: assets.appendingPathComponent(name), options: .atomic)
            controller.insertImage(assetPath: "assets/\(name)")
        } catch {
            Self.log.error("adding a photo to \(pageId, privacy: .public) failed: \(FailureText.kind(error), privacy: .public)")
            store.failure = FailureNotice(doing: "add the photo", error: error)
        }
    }

    /// Re-read the page after a write from the menu, only once it has loaded: the first load owns
    /// the failure state, and a version bump mid-load must not flip a fine page to "deleted".
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

