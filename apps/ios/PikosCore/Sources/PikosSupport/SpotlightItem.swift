import CoreSpotlight
import Foundation
import PikosCore
import UniformTypeIdentifiers

/// One page as the home screen's search holds it: what the list row shows and nothing from the
/// document body, which stays in the app's own full-text search where the excerpt can be quoted.
public enum SpotlightItem {
    public static let domain = "app.pikos.pages"

    /// Under the title, where it is: Spotlight already shows the app's name, and "Work · Fri 17
    /// Oct" is what tells two "Standup" pages apart. The subtitle follows when there is one.
    public static func make(for page: PageSummary, folderName: String?) -> CSSearchableItem {
        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = page.title.isEmpty ? String(localized: "Untitled") : page.title
        let date = page.scheduledStart.flatMap { StorageTimestamp.wallClock($0) }
        let place = [folderName ?? String(localized: "Inbox"), date.map(dayLabel)]
            .compactMap { $0 }
            .joined(separator: " · ")
        attributes.contentDescription = [place, page.subtitle].compactMap { $0 }.filter { !$0.isEmpty }
            .joined(separator: "\n")
        attributes.keywords = page.tags
        attributes.dueDate = date
        return CSSearchableItem(
            uniqueIdentifier: page.id, domainIdentifier: domain, attributeSet: attributes)
    }

    private static func dayLabel(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return String(localized: "Today") }
        if calendar.isDateInTomorrow(date) { return String(localized: "Tomorrow") }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }
}
