import Foundation
import UniformTypeIdentifiers

/// How a picked image is named on disk, and whether it can be stored as-is.
///
/// The editor renders whatever the webview can decode and the desktop renders
/// whatever its webview can, and the two agree on JPEG, PNG and GIF. A HEIC
/// from the camera roll is the common case that neither can be relied on for,
/// so it is re-encoded on the way in rather than stored and discovered broken
/// on the other device. This type only decides; the re-encoding needs UIKit
/// and lives in the app.
public enum AssetName {
    /// The extension a picked image keeps, or `nil` when it has to be
    /// re-encoded as JPEG first.
    ///
    /// Takes every type the picker reports, first preferred: a photo can be
    /// offered as both HEIC and JPEG, and the JPEG is the one worth keeping.
    public static func storableExtension(for types: [UTType]) -> String? {
        for type in types {
            if type.conforms(to: .jpeg) { return "jpg" }
            if type.conforms(to: .png) { return "png" }
            if type.conforms(to: .gif) { return "gif" }
        }
        return nil
    }

    /// A fresh file name: a UUID and the extension, nothing from the source.
    ///
    /// Nothing from the source on purpose. A photo's original name is not
    /// known to the picker anyway, and a name that could collide with an
    /// earlier pick would overwrite an image another page still shows.
    public static func fresh(extension ext: String) -> String {
        "\(UUID().uuidString.lowercased()).\(ext)"
    }
}
