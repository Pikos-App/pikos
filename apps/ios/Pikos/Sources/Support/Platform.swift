import SwiftUI

/// Where the app meets the version of iOS it is running on.
///
/// Two guards, and both matter. `#if compiler(>=6.2)` is the SDK: the
/// Liquid Glass modifiers exist only in the iOS 26 SDK, which ships with the
/// compiler that Xcode 26 carries, and a symbol the SDK does not declare fails
/// to compile whatever `#available` says around it. `#available(iOS 26.0, *)`
/// is then the device. Together they let one source tree build in Xcode 16
/// and 26 alike and look native on iOS 17 through 26.
///
/// The fallbacks are deliberately the system materials rather than a hand-
/// rolled imitation of glass. On iOS 18 the tab bar and toolbars already look
/// right; a custom floating control should match *them*, not the next OS.
extension View {
    /// Liquid Glass on a floating control, a material capsule elsewhere.
    ///
    /// For the app's own floating elements — the bottom bar, the notice
    /// bar — which sit in the navigation layer over content and are exactly
    /// what the new design language reserves glass for. Never applied to
    /// content: a list row or a calendar block on glass is the one thing the
    /// platform guidance says not to do.
    @ViewBuilder
    func floatingSurface<S: InsettableShape>(in shape: S, interactive: Bool = false) -> some View {
        #if compiler(>=6.2)
            if #available(iOS 26.0, *) {
                self.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
            } else {
                self.materialSurface(in: shape)
            }
        #else
            self.materialSurface(in: shape)
        #endif
    }

    private func materialSurface<S: InsettableShape>(in shape: S) -> some View {
        self
            .background(.regularMaterial, in: shape)
            .overlay(shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.14), radius: 10, y: 4)
    }
}
