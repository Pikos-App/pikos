import Foundation
import PikosSupport
import Testing

struct NowPlanTests {
    private let now = Date(timeIntervalSinceReferenceDate: 800_000_000)

    private func at(_ minutes: Int) -> Date {
        now.addingTimeInterval(TimeInterval(minutes * 60))
    }

    private func timed(_ id: String, from start: Int, to end: Int?, priority: Int = 0) -> NowPlan.Item {
        NowPlan.Item(id: id, start: at(start), end: end.map(at), priority: priority)
    }

    private func untimed(_ id: String, priority: Int = 0) -> NowPlan.Item {
        NowPlan.Item(id: id, start: nil, end: nil, priority: priority)
    }

    @Test func aSpanInProgressIsCurrentAndHidesTheSuggestion() {
        let plan = NowPlan(items: [timed("call", from: -10, to: 20), untimed("write")], now: now)
        #expect(plan.current?.id == "call")
        #expect(plan.suggestion == nil)
        #expect(plan.freeUntil == nil)
    }

    @Test func theGapBeforeTheNextPageIsFreeTimeWithASuggestion() {
        let plan = NowPlan(items: [timed("standup", from: 45, to: 60), untimed("write")], now: now)
        #expect(plan.current == nil)
        #expect(plan.next?.id == "standup")
        #expect(plan.freeUntil == at(45))
        #expect(plan.suggestion == NowPlan.Suggestion(id: "write", reason: .firstInList))
    }

    @Test func aPageWithNoEndIsNeverInProgressAndIsDueOnceItsTimePasses() {
        let plan = NowPlan(items: [timed("pills", from: -5, to: nil)], now: now)
        #expect(plan.current == nil)
        #expect(plan.suggestion == NowPlan.Suggestion(id: "pills", reason: .overdue))
    }

    @Test func priorityOutranksListOrderAndSaysSo() {
        let plan = NowPlan(items: [untimed("first"), untimed("urgent", priority: 1)], now: now)
        #expect(plan.suggestion == NowPlan.Suggestion(id: "urgent", reason: .topPriority))
    }

    @Test func equalPrioritiesFallBackToListOrder() {
        let plan = NowPlan(items: [untimed("a", priority: 2), untimed("b", priority: 2)], now: now)
        #expect(plan.suggestion?.id == "a")
    }

    @Test func nextIsTheSoonestToStartWhateverTheListOrder() {
        let plan = NowPlan(
            items: [timed("evening", from: 300, to: 360), timed("soon", from: 30, to: 60), timed("noon", from: 120, to: 150)],
            now: now)
        #expect(plan.next?.id == "soon")
        #expect(plan.freeUntil == at(30))
    }

    @Test func aPageStillAheadIsNotSuggested() {
        let plan = NowPlan(items: [timed("later", from: 30, to: 60)], now: now)
        #expect(plan.suggestion == nil)
        #expect(plan.freeUntil == at(30))
    }

    @Test func overlappingSpansShowTheOneEndingSoonest() {
        let plan = NowPlan(items: [timed("long", from: -30, to: 90), timed("short", from: -5, to: 10)], now: now)
        #expect(plan.current?.id == "short")
    }

    @Test func changesAreEveryFutureStartAndEndOnce() {
        let plan = NowPlan(items: [timed("a", from: -10, to: 20), timed("b", from: 20, to: 50)], now: now)
        #expect(plan.changes == [at(20), at(50)])
    }
}
