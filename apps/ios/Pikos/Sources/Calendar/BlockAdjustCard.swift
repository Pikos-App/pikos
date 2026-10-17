import SwiftUI

/// What a tap on a one-off calendar block shows: its time, steps to move or stretch it, and Open.
///
/// Each step applies as it's tapped and the card stays up, so "an hour later" is two taps and a
/// third keeps going. Undo on the notice goes back to the time the card opened on.
struct BlockAdjustCard: View {
    let title: String
    let time: String?
    let onShift: (Int) -> Void
    let onLengthen: (Int) -> Void
    let onOpen: () -> Void

    private static let steps = [-15, 15, 30, 60]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title.isEmpty ? String(localized: "Untitled") : title)
                    .font(.headline)
                    .foregroundStyle(.textPrimary)
                    .lineLimit(2)
                if let time {
                    Text(time)
                        .font(.subheadline)
                        .foregroundStyle(.textSecondary)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
            }
            row(String(localized: "Move"), action: onShift) { minutes, amount in
                minutes > 0 ? String(localized: "\(amount) later") : String(localized: "\(amount) earlier")
            }
            row(String(localized: "Length"), action: onLengthen) { minutes, amount in
                minutes > 0 ? String(localized: "\(amount) longer") : String(localized: "\(amount) shorter")
            }
            Button(action: onOpen) {
                Text("Open")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.interactiveFill)
        }
        .padding(16)
        .frame(width: 280)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private func row(
        _ label: String, action: @escaping (Int) -> Void, spoken: @escaping (Int, String) -> String
    ) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.textSecondary)
                .frame(width: 56, alignment: .leading)
            ForEach(Self.steps, id: \.self) { minutes in
                Button {
                    action(minutes)
                } label: {
                    Text(Self.stepLabel(minutes))
                        .font(.subheadline.weight(.medium))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.textAction)
                .accessibilityLabel(spoken(minutes, Self.amount(minutes)))
            }
        }
    }

    private static func stepLabel(_ minutes: Int) -> String {
        let sign = minutes < 0 ? "−" : "+"
        return abs(minutes) == 60 ? "\(sign)1h" : "\(sign)\(abs(minutes))"
    }

    private static func amount(_ minutes: Int) -> String {
        abs(minutes) == 60 ? String(localized: "1 hour") : String(localized: "\(abs(minutes)) minutes")
    }
}
