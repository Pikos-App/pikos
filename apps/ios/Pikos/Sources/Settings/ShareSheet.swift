import SwiftUI
import UIKit

/// `UIActivityViewController`, presented after the fact: `ShareLink` needs the shared thing
/// to exist when the view is built, and an export doesn't until the tap.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    /// Called once the sheet is gone, shared or not, so the temporary file can be removed.
    let onFinish: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in onFinish() }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
