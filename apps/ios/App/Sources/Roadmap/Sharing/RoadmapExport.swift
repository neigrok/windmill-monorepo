import SwiftUI
import UniformTypeIdentifiers
import RoadmapDomain

// Export (Roadmap on iOS §7.3; Roadmap · iOS 09.3, 07.11b): the open roadmap as one Markdown file, the plan grammar's
// writing of the phone's copy (`PlanFile`), which New Roadmap's A File reads back to the same steps. It asks no server and
// works signed out and offline. The system's exporter takes the file, named as the roadmap, and the person picks where it
// lands. The file holds the roadmap's title and steps, so neither its words nor its name are ever told.
nonisolated struct RoadmapMarkdown: FileDocument {
  // Markdown by the identifier the app's Info.plist imports, which the SDK names only from iOS 27.
  static let type = UTType(importedAs: "net.daringfireball.markdown", conformingTo: .plainText)
  static let readableContentTypes = [type]

  // Where Export was chosen, as its event names it: the root's title menu, or the … menu of a roadmap gone into.
  enum Door: String {
    case menu, more
  }

  let name: String
  let text: String
  let door: Door

  init(name: String, text: String, door: Door) {
    // The name the exporter offers is the roadmap's, with no character a file's name cannot hold.
    self.name = String(name.map { "/:".contains($0) ? "-" : $0 })
    self.text = text
    self.door = door
  }

  // The app writes this file and never opens one as it: New Roadmap's importer reads a plan.
  init(configuration: ReadConfiguration) throws {
    throw CocoaError(.fileReadUnsupportedScheme)
  }

  func fileWrapper(configuration: WriteConfiguration) -> FileWrapper {
    FileWrapper(regularFileWithContents: Data(text.utf8))
  }
}

extension RoadmapModel {
  // Export, in the title menu or the … menu: the open roadmap written as the room shows it, handed to the exporter, or
  // written where a launch names in its place.
  func export(from door: RoadmapMarkdown.Door) {
    guard let shown, let file = PlanFile(shown.listed.id, in: account) else { return }
    let markdown = RoadmapMarkdown(name: shown.listed.name, text: file.text, door: door)
    exporting = markdown
    telemetry.event("roadmap_export", properties: ["step": "open", "door": door.rawValue])
    guard let named = root.exportFile() else { return }
    do {
      try Data(markdown.text.utf8).write(to: named, options: .atomic)
      exported(.success(named))
    } catch {
      exported(.failure(error))
    }
  }

  // What the exporter came to: the file saved where the person chose, the exporter closed with nothing saved, or a file
  // the system could not write, which reports with its error's kind alone.
  func exported(_ written: Result<URL, any Error>?) {
    guard let file = exporting else { return }
    exporting = nil
    switch written {
    case .success: telemetry.event("roadmap_export", properties: ["outcome": "saved", "door": file.door.rawValue])
    case nil: telemetry.event("roadmap_export", properties: ["outcome": "cancelled", "door": file.door.rawValue])
    case .failure(let error):
      telemetry.event("roadmap_export", properties: ["outcome": "failed", "door": file.door.rawValue])
      telemetry.failure("roadmap_export", kind: error is CocoaError ? "storage" : "unexpected")
    }
  }
}

// The system's exporter over the room on top of the stack, raised by its Export.
struct RoadmapExporter: ViewModifier {
  let roadmap: RoadmapModel

  func body(content: Content) -> some View {
    // The exporter tells how it closed by its callbacks; a close that tells nothing is taken as cancelled once they would have.
    content.fileExporter(isPresented: Binding(get: { roadmap.exporting != nil }, set: { if !$0 { Task { roadmap.exported(nil) } } }),
                         document: roadmap.exporting, contentTypes: [RoadmapMarkdown.type], defaultFilename: roadmap.exporting?.name) { written in
      roadmap.exported(written)
    } onCancellation: {
      roadmap.exported(nil)
    }
  }
}
