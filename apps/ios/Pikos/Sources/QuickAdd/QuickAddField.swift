import PikosCore
import PikosSupport
import SwiftUI
import UIKit

/// Quick add's line, with the words the parser read coloured where they were typed.
///
/// A text view rather than a `TextField`, which cannot carry colour while it is edited. Restyling
/// waits while the keyboard has marked text, or composing in Japanese or Chinese would lose the
/// candidate under the colouring.
struct QuickAddField: UIViewRepresentable {
    @Binding var text: String
    /// The title the parser left, or nil when it read nothing and there is nothing to colour.
    let parsedTitle: String?
    let priority: Priority?
    let focusOnAppear: Bool
    let onSubmit: () -> Void

    static let placeholder = String(localized: "What needs doing?")

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextView {
        let view = FocusingTextView()
        view.focusOnWindow = focusOnAppear
        view.delegate = context.coordinator
        view.font = Coordinator.font
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(Color.textPrimary)
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.returnKeyType = .done
        view.autocorrectionType = .default
        view.accessibilityLabel = Self.placeholder
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let placeholder = UILabel()
        placeholder.text = Self.placeholder
        placeholder.font = Coordinator.font
        placeholder.adjustsFontForContentSizeCategory = true
        placeholder.textColor = UIColor(Color.textDisabled)
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        placeholder.isAccessibilityElement = false
        view.addSubview(placeholder)
        NSLayoutConstraint.activate([
            placeholder.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            placeholder.topAnchor.constraint(equalTo: view.topAnchor),
        ])
        context.coordinator.placeholder = placeholder
        return view
    }

    /// Takes the keyboard once it is in a window: asked any earlier, during the sheet's presentation,
    /// the request is dropped and the sheet opens with no keyboard.
    final class FocusingTextView: UITextView {
        var focusOnWindow = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard focusOnWindow, window != nil else { return }
            focusOnWindow = false
            becomeFirstResponder()
        }
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text {
            view.text = text
        }
        context.coordinator.placeholder?.isHidden = !text.isEmpty
        context.coordinator.restyle(view)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = Coordinator.font.lineHeight
        return CGSize(width: width, height: min(max(fitted.height, line), line * 5))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: QuickAddField
        weak var placeholder: UILabel?

        static var font: UIFont { UIFont.preferredFont(forTextStyle: .body) }

        init(_ parent: QuickAddField) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            placeholder?.isHidden = !textView.text.isEmpty
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard text == "\n" else { return true }
            parent.onSubmit()
            return false
        }

        /// Colours the text storage in place: replacing the text would reset the selection and cut
        /// autocorrect off mid-word.
        func restyle(_ view: UITextView) {
            guard view.markedTextRange == nil else { return }
            let base: [NSAttributedString.Key: Any] = [
                .font: Self.font, .foregroundColor: UIColor(Color.textPrimary),
            ]
            let line = view.text ?? ""
            let storage = view.textStorage
            storage.beginEditing()
            storage.setAttributes(base, range: NSRange(location: 0, length: storage.length))
            if let title = parent.parsedTitle {
                for token in QuickAddHighlight.tokens(in: line, title: title) {
                    storage.addAttribute(
                        .foregroundColor, value: UIColor(color(for: token.kind)),
                        range: NSRange(token.range, in: line))
                }
            }
            storage.endEditing()
            view.typingAttributes = base
        }

        private func color(for kind: QuickAddHighlight.Kind) -> Color {
            switch kind {
            case .when: return .textAction
            case .priority:
                switch parent.priority {
                case .urgent: return .statusOverdue
                case .high: return .statusDueSoon
                default: return .textSecondary
                }
            case .tag, .folder, .note: return .textTertiary
            }
        }
    }
}
