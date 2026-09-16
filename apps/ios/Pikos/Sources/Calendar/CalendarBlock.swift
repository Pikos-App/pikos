import PikosCore
import PikosSupport
import SwiftUI

/// A timed page on a grid, drawn the way the desktop draws one: the folder colour blended into
/// the ground, a full-strength stripe on the leading edge, and a checkbox stroked in that colour.
///
/// Type is a step below the list's, because a phone column is a third of a desktop one.
struct CalendarBlockView: View {
    let title: String
    let time: String?
    let tint: Color
    let isDone: Bool
    let height: CGFloat
    var showsText = true
    var showsCheckbox = true
    var isRecurring = false
    var squaredTop = false
    var squaredBottom = false
    var onToggle: (() -> Void)?

    @Environment(\.colorScheme) private var colorScheme

    private var isCompact: Bool { height < 34 }

    var body: some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: squaredTop ? 0 : 3, bottomLeadingRadius: squaredBottom ? 0 : 3,
            bottomTrailingRadius: squaredBottom ? 0 : 4, topTrailingRadius: squaredTop ? 0 : 4)

        HStack(alignment: isCompact ? .center : .top, spacing: 4) {
            if showsText {
                leadingMark
                    .padding(.top, isCompact ? 0 : 2)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title.isEmpty ? String(localized: "Untitled") : title)
                        .font(.system(.caption, weight: .medium))
                        .foregroundStyle(.textPrimary)
                        .lineLimit(isCompact ? 1 : max(1, Int((height - 16) / 15)))
                    if !isCompact, let time {
                        Text(time)
                            .font(.system(.caption2, weight: .medium))
                            .foregroundStyle(.textTertiary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 6)
        .padding(.trailing, 3)
        .padding(.vertical, isCompact ? 0 : 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            shape.fill(.surfacePrimary)
            shape.fill(tint.opacity(colorScheme == .dark ? 0.24 : 0.2))
        }
        .overlay(alignment: .leading) {
            Rectangle().fill(tint).frame(width: 2)
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(.surfacePrimary.opacity(0.7), lineWidth: 1))
        .opacity(isDone ? 0.5 : 1)
    }

    @ViewBuilder
    private var leadingMark: some View {
        if isRecurring && !showsCheckbox {
            Image(systemName: "repeat")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.textTertiary)
                .frame(width: 12, height: 12)
        } else if showsCheckbox {
            TaskCheckboxMark(isDone: isDone, stroke: tint, size: 12)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
                .onTapGesture { onToggle?() }
                .padding(-5)
                .accessibilityHidden(true)
        }
    }
}

enum CalendarPalette {
    /// The desktop's `DEFAULT_EVENT_COLOR`, for a page in no coloured folder.
    static var unfiled: Color { Color(PikosToken.blue500) }

    static func tint(folderId: String?, colors: [String: Color]) -> Color {
        folderId.flatMap { colors[$0] } ?? unfiled
    }

    static func folderColors(_ folders: [Folder]) -> [String: Color] {
        var colors: [String: Color] = [:]
        for folder in folders {
            if let color = Color(hex: folder.color) { colors[folder.id] = color }
        }
        return colors
    }

    @MainActor
    static func timeLabel(start: String, end: String?) -> String? {
        guard let startDate = StorageTimestamp.wallClock(start), start.contains("T") else {
            return nil
        }
        let startText = startDate.formatted(date: .omitted, time: .shortened)
        guard let end, let endDate = StorageTimestamp.wallClock(end), endDate > startDate else {
            return startText
        }
        return "\(startText) – \(endDate.formatted(date: .omitted, time: .shortened))"
    }
}
