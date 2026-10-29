import PikosSupport
import SwiftUI

struct AppearanceSettings: View {
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings

        SettingsPage(title: "Appearance") {
            Section {
                Picker("Theme", selection: $settings.theme) {
                    ForEach(Preferences.Theme.allCases, id: \.self) { theme in
                        Text(theme.label).tag(theme)
                    }
                }
                Picker("List density", selection: $settings.listDensity) {
                    ForEach(Preferences.ListDensity.allCases, id: \.self) { density in
                        Text(density.label).tag(density)
                    }
                }
            }
        }
    }
}
