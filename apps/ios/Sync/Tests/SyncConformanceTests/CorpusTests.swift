import SyncCore
import SyncTesting
import Testing

// One test case per corpus vector with a handler, and one pending known issue per file without one.

struct CorpusTests {
  @Test("vector", arguments: try Corpus.files().filter { Handlers.table[$0.path] != nil }.flatMap { try Corpus.vectors(in: $0) })
  func vector(_ vector: CorpusVector) throws {
    if let reason = Corpus.defects[vector.description] {
      withKnownIssue("corpus defect: \(reason)") { try check(vector) }
      return
    }
    try check(vector)
  }

  func check(_ vector: CorpusVector) throws {
    let handler = try #require(Handlers.table[vector.file])
    let answer: JSON
    do {
      answer = try handler(vector.input)
    } catch {
      answer = ["error": true]
      #expect(vector.expect == answer, "\(vector) threw: \(error)")
      return
    }
    #expect(answer == vector.expect, "\(vector)")
  }

  @Test("pending", arguments: try Corpus.files().filter { Handlers.table[$0.path] == nil })
  func pending(_ file: CorpusFile) {
    withKnownIssue("pending: no Swift handler yet for \(file)") {
      Issue.record("pending \(file.path)")
    }
  }

  @Test func everyCorpusFileHasOneRoleAndEveryRoleEntryAFile() throws {
    let paths = try Corpus.paths()
    let unclassified = paths.filter { Corpus.role(of: $0) == nil }
    let stale = Corpus.roles.map(\.entry).filter { entry in
      !paths.contains { $0 == entry || (entry.hasSuffix("/") && $0.hasPrefix(entry)) }
    }
    #expect(unclassified == [])
    #expect(stale == [])
  }

  @Test func everyHandlerNamesACorpusFile() throws {
    let paths = Set(try Corpus.paths())
    #expect(Handlers.table.keys.filter { !paths.contains($0) }.sorted() == [])
  }

  @Test(arguments: try Corpus.files().filter { $0.path.hasSuffix(".json") })
  func vectorNamesAreUniqueWithinAFile(_ file: CorpusFile) throws {
    let names = try Corpus.vectors(in: file).map(\.name)
    #expect(Set(names).count == names.count)
  }
}

extension CorpusVector: CustomTestStringConvertible {
  public var testDescription: String { description }
}

extension CorpusFile: CustomTestStringConvertible {
  public var testDescription: String { description }
}
