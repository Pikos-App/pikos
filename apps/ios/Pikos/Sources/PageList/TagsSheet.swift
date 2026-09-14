import PikosCore
import SwiftUI

/// A page's tags.
///
/// Quick add's line sets them once with `#work`, and until now nothing changed
/// them afterwards — so a page tagged wrongly, or not at all, stayed that way.
///
/// A list and one field rather than a comma-separated text box. The stored
/// value is a list, and a text box makes the reader do the splitting in their
/// head: whether a trailing comma means an empty tag, whether a space starts a
/// new one. Showing what is there as rows answers both by construction.
///
/// Offered on a calendar's page too. Tags are user-layer — the lock covers the
/// title and the schedule, not what somebody files a meeting under — and
/// tagging a mirror marks it owned, which is the data layer's business rather
/// than this sheet's.
struct TagsSheet: View {
    let page: PageFacts

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var tags: [String]
    @State private var entry = ""
    @State private var isSaving = false
    @FocusState private var entryFocused: Bool

    init(page: PageFacts) {
        self.page = page
        _tags = State(initialValue: page.tags)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("Add a tag", text: $entry)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($entryFocused)
                            // The keyboard's return key adds and stays, rather
                            // than dismissing: adding three tags is the normal
                            // case, and `.done` would close the keyboard after
                            // the first.
                            .submitLabel(.next)
                            .onSubmit(add)
                        Button("Add", action: add)
                            .disabled(cleaned(entry) == nil)
                    }
                } footer: {
                    Text("A leading # is optional — Pikos stores the word either way.")
                }

                if tags.isEmpty {
                    Section {
                        Text("No tags.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("Tags") {
                        // A list rather than a wrapping chip row. Swipe-to-delete
                        // is the gesture people already know for "remove this
                        // one", and it needs no hit target of its own next to
                        // text that may be long.
                        ForEach(tags, id: \.self) { tag in
                            Text(tag)
                        }
                        .onDelete { offsets in tags.remove(atOffsets: offsets) }
                    }
                }
            }
            .navigationTitle("Tags")
            .navigationBarTitleDisplayMode(.inline)
            .disabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        // The pending entry counts as a change, or Save would
                        // be disabled in exactly the case `save()` exists to
                        // handle: a tag typed but never committed.
                        Button("Save") { Task { await save() } }
                            .disabled(tags == page.tags && cleaned(entry) == nil)
                    }
                }
            }
            .onAppear { entryFocused = tags.isEmpty }
        }
    }

    /// The typed word, or nil when there is nothing worth adding.
    ///
    /// Duplicates are refused silently rather than flagged: adding a tag a page
    /// already carries is a no-op the user meant, not a mistake worth a
    /// sentence.
    private func cleaned(_ raw: String) -> String? {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") { value.removeFirst() }
        value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !tags.contains(value) else { return nil }
        return value
    }

    private func add() {
        guard let value = cleaned(entry) else { return }
        tags.append(value)
        entry = ""
        entryFocused = true
    }

    /// Saves what is typed as well as what is committed.
    ///
    /// Tapping Save with a half-typed tag in the field should not throw it
    /// away: the user's intent is visible on screen, and losing it to a missed
    /// return key is the kind of small betrayal that stops people trusting a
    /// form.
    private func save() async {
        isSaving = true
        defer { isSaving = false }
        add()
        await store.setTags(pageId: page.id, to: tags)
        dismiss()
    }
}
