import PikosCore
import SwiftUI

/// A page's tags, as chips: the ones it has, and the ones used elsewhere a tap away.
///
/// Each add and remove is saved as it happens, and a tag still being typed is kept when the sheet
/// closes, so there is no Save to miss.
///
/// Offered on a calendar's page too. Tags are user-layer, the lock covers the title and the
/// schedule and not what somebody files a meeting under, and tagging a mirror marks it owned,
/// which is the data layer's business rather than this sheet's.
struct TagsSheet: View {
    let page: PageFacts

    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var tags: [String]
    @State private var known: [String] = []
    @State private var entry = ""
    @FocusState private var entryFocused: Bool

    init(page: PageFacts) {
        self.page = page
        _tags = State(initialValue: page.tags)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    TextField("Add a tag", text: $entry)
                        .font(.pkBody)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($entryFocused)
                        // Return adds and stays: adding three tags is the normal case.
                        .submitLabel(.next)
                        .onSubmit(add)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(.surfaceHover, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                    if tags.isEmpty {
                        Text("No tags yet.")
                            .font(.pkBodySm)
                            .foregroundStyle(.textTertiary)
                    } else {
                        FlowLayout {
                            ForEach(tags, id: \.self) { tag in
                                Button {
                                    tags.removeAll { $0 == tag }
                                    saveTags()
                                } label: {
                                    HStack(spacing: 6) {
                                        Text("#\(tag)")
                                        Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                                    }
                                    .font(.pkUI)
                                    .foregroundStyle(.textInverse)
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 34)
                                    .background(Capsule().fill(.textAction))
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove \(tag)")
                            }
                        }
                    }

                    if !suggestions.isEmpty {
                        Text(entry.isEmpty ? "Your tags" : "Matching tags")
                            .sectionLabelStyle()
                        FlowLayout {
                            ForEach(suggestions, id: \.self) { tag in
                                Button {
                                    tags.append(tag)
                                    entry = ""
                                    saveTags()
                                } label: {
                                    Pill(title: "#\(tag)")
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Add \(tag)")
                            }
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .background(.surfaceElevated)
            .navigationTitle("Tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { known = await store.allTags() }
            .onAppear { entryFocused = tags.isEmpty }
        }
        .onDisappear {
            guard cleaned(entry) != nil else { return }
            add()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.surfaceElevated)
    }

    /// Tags used on other pages and not on this one, narrowed by what is typed.
    private var suggestions: [String] {
        let typed = entry.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        return known.filter { tag in
            !tags.contains(tag)
                && (typed.isEmpty || tag.range(of: typed, options: [.caseInsensitive, .diacriticInsensitive]) != nil)
        }
    }

    /// The typed word, or nil when there is nothing worth adding; a duplicate is a no-op the user meant.
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
        saveTags()
    }

    /// The whole list each time, which is what the workspace stores.
    private func saveTags() {
        let snapshot = tags
        let pageId = page.id
        Task { await store.setTags(pageId: pageId, to: snapshot) }
    }
}
