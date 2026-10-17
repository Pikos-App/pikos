import PikosSupport
import SwiftUI

extension ShapeStyle where Self == Color {
    static var surfacePrimary: Color { Color(PikosToken.surfacePrimary) }
    static var surfaceSecondary: Color { Color(PikosToken.surfaceSecondary) }
    static var surfaceTertiary: Color { Color(PikosToken.surfaceTertiary) }
    static var surfaceElevated: Color { Color(PikosToken.surfaceElevated) }
    static var surfaceInset: Color { Color(PikosToken.surfaceInset) }
    static var surfaceHover: Color { Color(PikosToken.surfaceHover) }
    static var surfaceActive: Color { Color(PikosToken.surfaceActive) }
    static var surfaceSelected: Color { Color(PikosToken.surfaceSelected) }
    static var surfaceNavSelected: Color { Color(PikosToken.surfaceNavSelected) }

    static var textPrimary: Color { Color(PikosToken.textPrimary) }
    static var textSecondary: Color { Color(PikosToken.textSecondary) }
    static var textTertiary: Color { Color(PikosToken.textTertiary) }
    static var textDisabled: Color { Color(PikosToken.textDisabled) }
    static var textInverse: Color { Color(PikosToken.textInverse) }
    /// The one teal for anything read as text. The desktop's link and brand teals fall under 4.5:1 on
    /// the light grounds, so the phone does not expose them.
    static var textAction: Color { Color(PikosToken.textAction) }
    static var textDueSoon: Color { Color(PikosToken.textDueSoon) }

    static var borderPrimary: Color { Color(PikosToken.borderPrimary) }
    static var borderSecondary: Color { Color(PikosToken.borderSecondary) }
    static var borderSubtle: Color { Color(PikosToken.borderSubtle) }

    static var interactivePrimary: Color { Color(PikosToken.interactivePrimary) }
    static var interactiveSecondary: Color { Color(PikosToken.interactiveSecondary) }
    static var interactiveFill: Color { Color(PikosToken.interactiveFill) }
    static var interactiveFillNeutral: Color { Color(PikosToken.interactiveFillNeutral) }

    static var statusOverdue: Color { Color(PikosToken.statusOverdue) }
    static var statusDueSoon: Color { Color(PikosToken.statusDueSoon) }
    static var statusOpen: Color { Color(PikosToken.statusOpen) }
    static var statusDone: Color { Color(PikosToken.statusDone) }
}

/// The desktop's type scale on a phone: each step is the desktop size × 1.15, snapped to the
/// nearest Dynamic Type style so it still follows the reader's text size. Weights carry over.
extension Font {
    static let pkDisplay = Font.system(.title, weight: .semibold)
    static let pkHeadingLg = Font.system(.title3, weight: .semibold)
    static let pkHeadingSm = Font.system(.body, weight: .medium)
    static let pkBody = Font.system(.callout)
    static let pkBodyMedium = Font.system(.callout, weight: .medium)
    static let pkBodySm = Font.system(.subheadline)
    static let pkUI = Font.system(.subheadline, weight: .medium)
    static let pkUISm = Font.system(.caption, weight: .medium)
    static let pkMono = Font.system(.footnote, design: .monospaced)

    /// The phone's own: a pane's name sits where the desktop has a sidebar, so it carries more weight.
    static let pkScreenTitle = Font.system(.title2, weight: .semibold)
}

extension Animation {
    /// The one length for motion: short enough that nobody waits on it. A move worth showing says
    /// what it means in this time, and one that needs longer is there for its own sake.
    static let pkQuick = Animation.snappy(duration: 0.2)
}

extension View {
    /// The desktop's small-caps section label: "FOLDERS", "MON 14", "OVERDUE".
    func sectionLabelStyle(_ color: Color = .textTertiary) -> some View {
        self.font(.pkUISm)
            .textCase(.uppercase)
            .tracking(0.4)
            .foregroundStyle(color)
    }

    /// A settings-style form on the desktop's warm neutrals instead of the system's blue-gray.
    func pikosFormStyle() -> some View {
        self.scrollContentBackground(.hidden)
            .background(.surfaceTertiary)
    }

    /// A 44pt touch target around a control drawn smaller, laid out at its drawn size: the extra area
    /// is added for hit testing and then taken back, so a compact byline or header keeps its spacing.
    func touchTarget(vertical: CGFloat = 14, horizontal: CGFloat = 6) -> some View {
        self.padding(.vertical, vertical)
            .padding(.horizontal, horizontal)
            .contentShape(Rectangle())
            .padding(.vertical, -vertical)
            .padding(.horizontal, -horizontal)
    }

    /// The rows of a `pikosFormStyle` form, on the raised surface. Left alone they take the system's
    /// grouped grey, which on the dark theme's warm ground reads as another app. Applied to the form's
    /// content rather than the form, because a row background is read off each row.
    func pikosFormRows() -> some View {
        self.listRowBackground(Color.surfaceElevated)
    }
}

/// The square checkbox the desktop draws, with its stroke carrying priority while open.
struct TaskCheckboxMark: View {
    let isDone: Bool
    var stroke: Color = .borderPrimary
    var size: CGFloat = 20

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
            .strokeBorder(isDone ? Color.clear : stroke, lineWidth: 1.5)
            .background(
                RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                    .fill(isDone ? Color.textTertiary.opacity(0.55) : Color.clear)
            )
            .overlay {
                if isDone {
                    Image(systemName: "checkmark")
                        .font(.system(size: size * 0.55, weight: .bold))
                        .foregroundStyle(.white)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .frame(width: size, height: size)
            .animation(.pkQuick, value: isDone)
    }
}
