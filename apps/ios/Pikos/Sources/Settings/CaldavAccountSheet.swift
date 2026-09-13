import PikosCore
import SwiftUI

/// Connect a CalDAV server, or repair one whose password stopped working.
///
/// One sheet for both because they are the same form minus three fields, and
/// two nearly-identical screens is two places for the keyboard type, the
/// autocorrect settings and the submit wiring to drift.
///
/// Reconnecting asks for the password *alone*, deliberately. The server and
/// username already live in the keychain, and re-collecting them would let a
/// typo in either land a second account rather than repairing this one —
/// identity is provider plus display name, and a repair must not change it.
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
                if case .reconnect(let account) = mode {
                    Section {
                        LabeledContent("Account", value: account.displayName)
                    } footer: {
                        Text("The server and username are already saved. Only the password changes.")
                    }
                } else {
                    Section {
                        // No autocapitalisation and no autocorrect on any of
                        // these: a server URL and a username are not prose, and
                        // iOS helpfully capitalising the first letter of a
                        // username is a failed login nobody can see the cause of.
                        TextField("https://caldav.example.com", text: $baseURL)
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
                        Text("Server")
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
                        // Not cosmetic: identity is provider plus this name, so
                        // it decides whether a later connection repairs this
                        // account or creates a second one beside it.
                        Text("How it appears in Pikos. Reconnecting later matches on this name, so pick something you will use again.")
                    }
                }
            }
            .navigationTitle(mode.isReconnect ? "Reconnect" : "Add account")
            .navigationBarTitleDisplayMode(.inline)
            .disabled(isWorking)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isWorking {
                        // The server is being contacted, which can take a
                        // while on a bad connection. A spinner where the
                        // button was says so without moving anything.
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

    /// Closes only on success.
    ///
    /// A failed connection leaves the form standing with what was typed still
    /// in it, because the likely next action is fixing one character. Dismissing
    /// and showing an error would make the user retype the lot.
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
