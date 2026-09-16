import SwiftUI

/// The top of a pane: its name on the left, its tools on the right, a hairline under both.
struct PaneHeader<Leading: View, Trailing: View>: View {
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            leading()
            Spacer(minLength: 8)
            HStack(spacing: 0) { trailing() }
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .background(.surfacePrimary)
        .overlay(alignment: .bottom) {
            Rectangle().fill(.borderSecondary).frame(height: 1 / displayScale)
        }
    }
}

struct HeaderIconButton: View {
    let systemImage: String
    let label: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .regular))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(HeaderIconStyle())
        .accessibilityLabel(label)
    }
}

struct HeaderIconStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? Color.textSecondary : Color.textDisabled)
            .background {
                Circle()
                    .fill(.surfaceHover)
                    .frame(width: 36, height: 36)
                    .opacity(configuration.isPressed ? 1 : 0)
            }
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// A press that dims rather than flashes — the desktop's hover, on a finger.
struct PressableRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.surfaceHover : Color.clear)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
