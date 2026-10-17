/// Palette values that have since moved, mapped when a stored colour is read.
///
/// Mirror of `currentPaletteColor` in `packages/core/src/constants/colors.ts`, which says why: the
/// palette's red moved away from the overdue red, and a folder that stored the old value is drawn,
/// and marked in the picker, as the new one without a migration.
public enum CurrentPaletteColor {
    private static let moved: [String: String] = ["#E5534B": "#D9577A"]

    public static func of(_ stored: String?) -> String? {
        guard let stored else { return nil }
        return moved[stored.uppercased()] ?? stored
    }
}
