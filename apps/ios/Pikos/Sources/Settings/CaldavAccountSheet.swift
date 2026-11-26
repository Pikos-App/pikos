import PikosCore
import SwiftUI

/// Connect a CalDAV server, or repair one whose password stopped working.
///
/// One sheet for both so the field settings don't drift. Reconnecting asks for the password
/// alone, as `CalendarSyncStore.reconnect` does. Identity is provider plus display name.
struct CaldavAccountSheet: View {
    enum Mode {
        case connect
        case reconnect(SyncAccount)

        var isReconnect: Bool {
            if case .reconnect = self { return true }
            return false
        }
    }

    let mode: Mode

    @Environment(CalendarSyncStore.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var baseURL = ""
    @State private var username = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var isWorking = false
    @FocusState private var focus: Field?

    private enum Field { case url, username, password, name }

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    if case .reconnect(let account) = mode {
                        Section {
                            LabeledContent("Account", value: account.displayName)
                        } footer: {
                            Text("The server and username are already saved. Only the password changes.")
                        }
                    } else {
                        Section {
                            // No autocapitalisation or autocorrect: a capitalised username is a failed login with no
                            // visible cause.
                            // Verbatim: a localized prompt is Markdown, which turns a URL into a system-blue link.
                            TextField(text: $baseURL, prompt: Text(verbatim: "https://caldav.example.com")) {
                                Text("Server URL")
                            }
                                .keyboardType(.URL)
                                .textContentType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($focus, equals: .url)
                                .submitLabel(.next)
                                .onSubmit { focus = .username }

                            TextField("Username", text: $username)
                                .textContentType(.username)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($focus, equals: .username)
                                .submitLabel(.next)
                                .onSubmit { focus = .password }
                        } header: {
                            Text("Server").sectionLabelStyle()
                        } footer: {
                            Text("Fastmail, iCloud, Nextcloud and most self-hosted calendars speak CalDAV. Some require an app-specific password rather than your usual one.")
                        }
                    }

                    Section {
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .focused($focus, equals: .password)
                            .submitLabel(mode.isReconnect ? .done : .next)
                            .onSubmit {
                                if mode.isReconnect {
                                    Task { await submit() }
                                } else {
                                    focus = .name
                                }
                            }
                    }

                    if !mode.isReconnect {
                        Section {
                            TextField("Name this account", text: $displayName)
                                .focused($focus, equals: .name)
                                .submitLabel(.done)
                                .onSubmit { Task { await submit() } }
                        } footer: {
                            Text("How it appears in Pikos. Reconnecting later matches on this name, so pick something you will use again.")
                        }
                    }
                }
                .pikosFormRows()
            }
            .navigationTitle(mode.isReconnect ? "Reconnect" : "Add account")
            .pikosFormStyle()
            .navigationBarTitleDisplayMode(.inline)
            .disabled(isWorking)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isWorking {
                        ProgressView()
                    } else {
                        Button(mode.isReconnect ? "Save" : "Connect") {
                            Task { await submit() }
                        }
                        .disabled(!isComplete)
                    }
                }
            }
            .onAppear { focus = mode.isReconnect ? .password : .url }
        }
        .interactiveDismissDisabled(isWorking)
    }

    private var isComplete: Bool {
        guard !password.isEmpty else { return false }
        if mode.isReconnect { return true }
        return !trimmed(baseURL).isEmpty && !trimmed(username).isEmpty
            && !trimmed(displayName).isEmpty
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Closes only on success: a failed connection keeps what was typed, since the next action
    /// is likely fixing one character.
    private func submit() async {
        guard isComplete, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }

        let ok: Bool
        switch mode {
        case .connect:
            ok = await sync.connect(
                baseURL: baseURL, username: username, password: password,
                displayName: displayName)
        case .reconnect(let account):
            ok = await sync.reconnect(accountID: account.id, password: password)
        }
        if ok { dismiss() }
    }
}
