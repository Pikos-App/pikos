import SwiftUI

/// Where the app meets the version of iOS it is running on.
///
/// `#if compiler(>=6.2)` is the SDK: a symbol the SDK does not declare fails to compile whatever
/// `#available` says around it. `#available(iOS 26.0, *)` is then the device. The fallbacks are
/// the system materials, not an imitation of glass.
extension View {
    /// Liquid Glass on a floating control, a material capsule elsewhere.
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
