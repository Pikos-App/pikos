import Foundation
import XCTest

@testable import PikosSupport

final class WorkspaceFilesTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-files-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testSizeCountsTheDatabaseItsSidecarsAndEveryImage() throws {
        let database = root.appendingPathComponent("pikos.sqlite")
        try Data(count: 100).write(to: database)
        try Data(count: 20).write(to: root.appendingPathComponent("pikos.sqlite-wal"))
        try Data(count: 5).write(to: root.appendingPathComponent("pikos.sqlite-shm"))

        let assets = root.appendingPathComponent("assets", isDirectory: true)
        let nested = assets.appendingPathComponent("2026", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try Data(count: 7).write(to: assets.appendingPathComponent("a.jpg"))
        try Data(count: 3).write(to: nested.appendingPathComponent("b.png"))

        XCTAssertEqual(WorkspaceFiles.size(database: database, assets: assets), 135)
    }

    func testSizeIsZeroForAWorkspaceThatDoesNotExistYet() {
        let database = root.appendingPathComponent("missing.sqlite")
        XCTAssertEqual(WorkspaceFiles.size(database: database, assets: nil), 0)
    }

    func testBackupNameIsReadableAndSortable() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let date = utc.date(from: DateComponents(year: 2026, month: 9, day: 14, hour: 22, minute: 4))!
        XCTAssertEqual(WorkspaceFiles.backupName(at: date, calendar: utc), "Pikos 2026-09-14 22-04")
    }

    func testLatestBackupIsTheNewestFolderAndIgnoresLooseFiles() throws {
        let backups = root.appendingPathComponent("Backups", isDirectory: true)
        let older = backups.appendingPathComponent("Pikos 2026-09-01 09-00", isDirectory: true)
        let newer = backups.appendingPathComponent("Pikos 2026-09-14 22-04", isDirectory: true)
        try FileManager.default.createDirectory(at: older, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: newer, withIntermediateDirectories: true)
        try Data(count: 1).write(to: backups.appendingPathComponent("stray.txt"))

        let earlier = Date(timeIntervalSince1970: 1_000_000)
        try FileManager.default.setAttributes([.creationDate: earlier], ofItemAtPath: older.path)
        let later = Date(timeIntervalSince1970: 2_000_000)
        try FileManager.default.setAttributes([.creationDate: later], ofItemAtPath: newer.path)

        XCTAssertEqual(WorkspaceFiles.latestBackup(in: backups), later)
    }

    func testLatestBackupIsNilWhenNothingHasBeenWritten() {
        XCTAssertNil(WorkspaceFiles.latestBackup(in: root.appendingPathComponent("nowhere")))
    }

    func testHasContentsSeesThroughAnEmptyDirectory() throws {
        let empty = root.appendingPathComponent("empty", isDirectory: true)
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        XCTAssertFalse(WorkspaceFiles.hasContents(empty))
        try Data(count: 1).write(to: empty.appendingPathComponent("one"))
        XCTAssertTrue(WorkspaceFiles.hasContents(empty))
    }
}
