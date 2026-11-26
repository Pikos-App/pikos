import ActivityKit
import PikosSupport
import SwiftUI
import WidgetKit

/// A focus session, in the Dynamic Island and on the lock screen, drawn from
/// `FocusActivityAttributes`. The clock is `Text(timerInterval:)`, counted by the system from the
/// start instant, so it stays right with the app suspended. No stop button: ending a session
/// writes through the app's store, and a button here would run in this process as a second
/// writer. The tap opens the page, one tap from the stop control.
struct FocusLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FocusActivityAttributes.self) { context in
            // The lock screen and the banner.
            HStack(spacing: 12) {
                Image(systemName: "timer")
                    .font(.title2)
                    .foregroundStyle(Brand.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Focusing")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .multilineTextAlignment(.trailing)
            }
            .padding(16)
            .widgetURL(Self.pageURL(context.attributes.pageId))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "timer")
                        .font(.title2)
                        .foregroundStyle(Brand.accent)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                        .font(.title2.weight(.semibold).monospacedDigit())
                        .multilineTextAlignment(.trailing)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.attributes.title)
                        .font(.subheadline)
                        .lineLimit(1)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: "timer")
                    .foregroundStyle(Brand.accent)
            } compactTrailing: {
                // Wide enough for "1:02:33" and no wider, so the island doesn't grow as the minutes pass.
                Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 64)
            } minimal: {
                Image(systemName: "timer")
                    .foregroundStyle(Brand.accent)
            }
            .widgetURL(Self.pageURL(context.attributes.pageId))
        }
    }

    private static func pageURL(_ pageId: String) -> URL? {
        URL(string: "pikos://page/\(pageId)")
    }
}
