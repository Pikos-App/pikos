import SwiftUI
import UIKit

/// `UIActivityViewController`, which SwiftUI has no equivalent of.
///
/// `ShareLink` is the SwiftUI way and does not fit: it wants the thing being
/// shared to exist when the view is built, and an export does not exist until
/// somebody taps and waits. This presents the same sheet after the fact.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    /// Called once the sheet is gone, whether or not anything was shared — the
    /// exported file is in a temporary directory and there is nothing left to
    /// do with it.
    let onFinish: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in onFinish() }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
