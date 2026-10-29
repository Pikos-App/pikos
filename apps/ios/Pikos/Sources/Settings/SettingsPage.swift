import SwiftUI

/// One page pushed from the settings list, styled as the list is.
struct SettingsPage<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let content: Content

    var body: some View {
        Form {
            Group { content }
                .pikosFormRows()
        }
        .navigationTitle(title)
        .pikosFormStyle()
        .navigationBarTitleDisplayMode(.inline)
    }
}
