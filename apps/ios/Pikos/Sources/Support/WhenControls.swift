import PikosCore
import PikosSupport
import SwiftUI
import UIKit

extension WhenChoice: @retroactive Identifiable {
    public var id: String { rawValue }

    var label: String {
        switch self {
        case .today: return String(localized: "Today")
        case .tomorrow: return String(localized: "Tomorrow")
        case .thisWeekend: return String(localized: "This weekend")
        case .nextWeek: return String(localized: "Next week")
        }
    }

    var systemImage: String {
        switch self {
        case .today: return "sun.max"
        case .tomorrow: return "sunrise"
        case .thisWeekend: return "sofa"
        case .nextWeek: return "arrow.forward.to.line"
        }
    }
}

/// The When choices, in the order and words every date control in the app uses.
struct WhenMenuItems: View {
    var choices: [WhenChoice] = WhenChoice.allCases
    let onChoose: (WhenChoice) -> Void
    var onPickDate: (() -> Void)?
    var onClear: (() -> Void)?

    var body: some View {
        ForEach(choices) { choice in
            Button {
                onChoose(choice)
            } label: {
                Label(choice.label, systemImage: choice.systemImage)
            }
        }
        if onPickDate != nil || onClear != nil {
            Divider()
        }
        if let onPickDate {
            Button(action: onPickDate) {
                Label("Pick a date…", systemImage: "calendar")
            }
        }
        if let onClear {
            Button(action: onClear) {
                Label("No date", systemImage: "calendar.badge.minus")
            }
        }
    }
}

/// A colour a menu row keeps.
///
/// Menus retint SF Symbols with the accent, which drew every folder dot and every colour choice
/// in the same teal; an original-rendering image is the one a menu leaves alone.
enum MenuSwatch {
    static func image(_ color: Color, systemName: String = "circle.fill") -> Image {
        let base = UIImage(systemName: systemName) ?? UIImage()
        return Image(uiImage: base.withTintColor(UIColor(color), renderingMode: .alwaysOriginal))
    }
}

/// Inbox and every folder a page can be filed in, each with its colour, as picker rows.
struct FolderChoices: View {
    let folders: [Folder]

    var body: some View {
        Label("Inbox", systemImage: "tray").tag(String?.none)
        ForEach(folders, id: \.id) { folder in
            Label {
                Text(folder.name.isEmpty ? String(localized: "Untitled") : folder.name)
            } icon: {
                MenuSwatch.image(Color(hex: folder.color) ?? .textDisabled)
            }
            .tag(String?.some(folder.id))
        }
    }
}

/// A priority's mark as an image in its colour, for menu rows, which take an image and not text.
enum PriorityMark {
    static func image(_ priority: PagePriority) -> Image {
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 16, weight: .heavy)]
        let mark = NSString(string: priority.mark)
        let markSize = mark.size(withAttributes: attributes)
        let size = CGSize(width: 22, height: 22)
        let drawn = UIGraphicsImageRenderer(size: size).image { _ in
            mark.draw(
                at: CGPoint(x: (size.width - markSize.width) / 2, y: (size.height - markSize.height) / 2),
                withAttributes: attributes)
        }
        return Image(uiImage: drawn.withTintColor(UIColor(priority.color), renderingMode: .alwaysOriginal))
    }

    static var none: Image { MenuSwatch.image(.textTertiary, systemName: "minus") }
}

/// No priority and the four levels, each with its mark in its colour, as picker rows tagged by stored value.
struct PriorityChoices: View {
    var body: some View {
        Label { Text("None") } icon: { PriorityMark.none }.tag(Int64(0))
        ForEach(PagePriority.allCases) { option in
            Label {
                Text(option.name)
            } icon: {
                PriorityMark.image(option)
            }
            .tag(option.stored)
        }
    }
}

/// Priority as one row of marks in their colours, so setting it is a tap rather than a submenu.
///
/// Not in a menu attached to anything draggable: a palette there stops the view lifting for a drag.
struct PriorityPalette: View {
    let stored: Int64
    let onChoose: (Priority?) -> Void

    var body: some View {
        Picker(
            "Priority",
            selection: Binding(
                get: { PagePriority(stored: stored)?.stored ?? 0 },
                set: { onChoose(PagePriority(stored: $0)?.value) })
        ) {
            Label { Text("No priority") } icon: { PriorityMark.none }.tag(Int64(0))
            ForEach(PagePriority.allCases) { option in
                Label { Text(option.name) } icon: { PriorityMark.image(option) }
                    .tag(option.stored)
            }
        }
        .pickerStyle(.palette)
    }
}

/// Views laid out in rows, wrapping to the next row when the width runs out.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = arrange(width: bounds.width, subviews: subviews).frames
        for (subview, frame) in zip(subviews, frames) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
            // One item wider than the row would widen the whole layout, and with it the screen.
            size.width = min(size.width, width)
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + lineHeight), frames)
    }
}

/// A small rounded choice: a day in the When sheet, a tag, a search filter.
struct Pill: View {
    let title: String
    var systemImage: String?
    var dot: Color?
    var isOn = false

    var body: some View {
        HStack(spacing: 6) {
            if let dot {
                Circle().fill(dot).frame(width: 8, height: 8)
            } else if let systemImage {
                Image(systemName: systemImage).font(.system(size: 12, weight: .medium))
            }
            Text(title).lineLimit(1)
        }
        .font(.pkUI)
        .foregroundStyle(isOn ? Color.textInverse : Color.textSecondary)
        .padding(.horizontal, 12)
        .frame(minHeight: 34)
        .background(Capsule().fill(isOn ? Color.textAction : Color.surfaceHover))
        .contentShape(Capsule())
    }
}
