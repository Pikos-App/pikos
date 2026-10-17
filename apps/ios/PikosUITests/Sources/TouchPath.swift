import XCTest

/// One finger held down along several stops, for a drag that has to wait somewhere on the way.
///
/// `press(forDuration:thenDragTo:)` goes in one straight line, so it can't carry a page onto a
/// spring-loaded button, wait for it to open, and then carry on to what opened. This drives XCTest's
/// own event synthesizer, the private one behind every public gesture, through the Objective-C
/// runtime, so a change to it fails here, loudly, rather than in a test's assertions.
@MainActor
struct TouchPath {
    struct Stop {
        let point: CGPoint
        /// How long the finger rests here before moving on to the next stop.
        let hold: TimeInterval
    }

    /// Seconds to travel between two stops.
    static let travel: TimeInterval = 0.4

    let stops: [Stop]

    func perform(file: StaticString = #filePath, line: UInt = #line) {
        guard let first = stops.first,
            let pathClass = NSClassFromString("XCPointerEventPath") as? NSObject.Type,
            let recordClass = NSClassFromString("XCSynthesizedEventRecord") as? NSObject.Type
        else {
            XCTFail("XCTest no longer has its event synthesizer", file: file, line: line)
            return
        }

        typealias InitTouch = @convention(c) (AnyObject, Selector, CGPoint, Double) -> AnyObject
        typealias MoveTouch = @convention(c) (AnyObject, Selector, CGPoint, Double) -> Void
        typealias LiftTouch = @convention(c) (AnyObject, Selector, Double) -> Void
        typealias InitRecord = @convention(c) (AnyObject, Selector, NSString, Int) -> AnyObject

        let initTouch = NSSelectorFromString("initForTouchAtPoint:offset:")
        let path = unsafeBitCast(pathClass.instanceMethod(for: initTouch), to: InitTouch.self)(
            Self.allocate(pathClass), initTouch, first.point, 0)

        let moveTouch = NSSelectorFromString("moveToPoint:atOffset:")
        let move = unsafeBitCast(pathClass.instanceMethod(for: moveTouch), to: MoveTouch.self)
        var offset = first.hold
        move(path, moveTouch, first.point, offset)
        for stop in stops.dropFirst() {
            offset += Self.travel
            move(path, moveTouch, stop.point, offset)
            offset += stop.hold
            move(path, moveTouch, stop.point, offset)
        }
        let liftTouch = NSSelectorFromString("liftUpAtOffset:")
        unsafeBitCast(pathClass.instanceMethod(for: liftTouch), to: LiftTouch.self)(path, liftTouch, offset + 0.05)

        let initRecord = NSSelectorFromString("initWithName:interfaceOrientation:")
        let record = unsafeBitCast(recordClass.instanceMethod(for: initRecord), to: InitRecord.self)(
            Self.allocate(recordClass), initRecord, "touch path" as NSString, UIInterfaceOrientation.portrait.rawValue)
        _ = record.perform(NSSelectorFromString("addPointerEventPath:"), with: path)

        guard let synthesizer = XCUIDevice.shared.value(forKey: "eventSynthesizer") as? NSObject else {
            XCTFail("XCTest no longer has its event synthesizer", file: file, line: line)
            return
        }
        let done = XCTestExpectation(description: "the touch path played")
        let completion: @convention(block) (Bool, NSError?) -> Void = { _, _ in done.fulfill() }
        _ = synthesizer.perform(
            NSSelectorFromString("synthesizeEvent:completion:"), with: record,
            with: unsafeBitCast(completion, to: AnyObject.self))
        XCTWaiter().wait(for: [done], timeout: offset + 10)
    }

    private static func allocate(_ type: NSObject.Type) -> AnyObject {
        (type as AnyObject).perform(NSSelectorFromString("alloc")).takeUnretainedValue()
    }
}
