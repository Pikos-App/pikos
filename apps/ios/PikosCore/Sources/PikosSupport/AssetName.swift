import Foundation
import UniformTypeIdentifiers

/// How a picked image is named on disk, and whether it can be stored as-is.
///
/// Only JPEG, PNG and GIF are stored as-is: both webviews decode those, while
/// HEIC from the camera roll would be discovered broken on the other device.
/// This type only decides; the re-encoding needs UIKit and lives in the app.
public enum AssetName {
    /// The extension a picked image keeps, or `nil` when it has to be
    /// re-encoded as JPEG first.
    ///
    /// Takes every type the picker reports, first preferred: a photo offered as
    /// both HEIC and JPEG keeps the JPEG.
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
    /// A name that could collide with an earlier pick would overwrite an image
    /// another page still shows.
    public static func fresh(extension ext: String) -> String {
        "\(UUID().uuidString.lowercased()).\(ext)"
    }
}
