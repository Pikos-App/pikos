import SwiftUI
import UIKit

/// A hold that, once it takes, follows the finger until it lifts: points are in the view's own
/// space, the first where the hold began.
///
/// UIKit's long press rather than SwiftUI's: a SwiftUI gesture that reports while the finger
/// moves makes the scroll view behind the grid wait on it, so every scroll started on empty grid
/// stuttered or stalled. The recognizer loses to the scroll when the finger moves first and wins
/// when it stays still, which is the whole distinction, and costs a scroll nothing until it wins.
/// `HoldAndDrag` where it exists. Before iOS 18 a hold reports only where it began, as it is let
/// go, which still opens quick add on the slot, just without drawing out a length.
struct HoldToDraw: ViewModifier {
    var minimumDuration: TimeInterval = 0.5
    let onChange: (_ start: CGPoint, _ now: CGPoint) -> Void
    let onEnd: (_ start: CGPoint, _ now: CGPoint) -> Void
    let onCancel: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.gesture(
                HoldAndDrag(minimumDuration: minimumDuration, onChange: onChange, onEnd: onEnd, onCancel: onCancel))
        } else {
            content.gesture(
                LongPressGesture(minimumDuration: minimumDuration)
                    .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
                    .onEnded { value in
                        if case .second(true, let drag?) = value {
                            onEnd(drag.startLocation, drag.startLocation)
                        }
                    })
        }
    }
}

@available(iOS 18.0, *)
struct HoldAndDrag: UIGestureRecognizerRepresentable {
    var minimumDuration: TimeInterval = 0.5
    let onChange: (_ start: CGPoint, _ now: CGPoint) -> Void
    let onEnd: (_ start: CGPoint, _ now: CGPoint) -> Void
    let onCancel: () -> Void

    final class Coordinator {
        var start: CGPoint = .zero
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = minimumDuration
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        let point = context.converter.localLocation
        switch recognizer.state {
        case .began:
            context.coordinator.start = point
            onChange(point, point)
        case .changed:
            onChange(context.coordinator.start, point)
        case .ended:
            onEnd(context.coordinator.start, point)
        case .cancelled, .failed:
            onCancel()
        default:
            break
        }
    }
}
