import PikosSupport
import SwiftUI

struct AboutSettings: View {
    var body: some View {
        SettingsPage(title: "About") {
            Section {
                // Not decoration: a page written by a newer build cannot be
                // saved over by this one, and when somebody hits that the
                // first useful question is which version each device is on.
                LabeledContent("Version", value: Self.version)
                Link(destination: URL(string: "mailto:hello@pikos.app")!) {
                    LabeledContent {
                        Text(verbatim: "hello@pikos.app").foregroundStyle(.textSecondary)
                    } label: {
                        Label("Send feedback", systemImage: "envelope")
                    }
                }
                Link(destination: Self.bugReportURL) {
                    Label("Report a bug", systemImage: "ladybug")
                }
                Link(destination: URL(string: "https://pikos.app/privacy")!) {
                    Label("Privacy", systemImage: "hand.raised")
                }
            }

            #if DEBUG
                // The first device run's checklist, answered on screen —
                // see docs/ios/07-device-checklist.md. Not in a release
                // build: a container path is nobody's business but the
                // developer's, and the attribute read behind it would
                // need a privacy declaration the shipped binary should
                // not have to make.
                Section {
                    ForEach(Diagnostics.report()) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.label).font(.caption).foregroundStyle(.textSecondary)
                            Text(row.value).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                } header: {
                    Text("Diagnostics (debug build)").sectionLabelStyle()
                } footer: {
                    Text(
                        "Lock the phone, wait for a widget to refresh, then come back: every file above should still read “until first unlock”."
                    )
                }
            #endif
        }
    }

    /// The site's bug form, with the platform and version filled in as the desktop's link does.
    private static var bugReportURL: URL {
        var components = URLComponents(string: "https://pikos.app/bugs")!
        components.queryItems = [URLQueryItem(name: "os", value: "iOS"), URLQueryItem(name: "version", value: version)]
        return components.url!
    }

    /// The marketing version and build, as Xcode stamped them.
    ///
    /// Read from the bundle rather than from a constant in the source: a
    /// constant is a second place to remember on every release, and the one
    /// that gets forgotten is always the one the user is reading.
    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        guard let build = info?["CFBundleVersion"] as? String, build != short else { return short }
        return "\(short) (\(build))"
    }
}
