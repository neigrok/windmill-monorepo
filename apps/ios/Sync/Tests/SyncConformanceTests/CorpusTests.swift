import SyncCore
import SyncTesting
import Testing

// One test case per corpus vector with a handler; a corpus file without one fails the run.

struct CorpusTests {
  @Test("vector", arguments: try Corpus.files().filter { $0.role != .cppOnly && Handlers.table[$0.path] != nil }.flatMap { try Corpus.vectors(in: $0) })
  func vector(_ vector: CorpusVector) async throws {
    let handler = try #require(Handlers.table[vector.file])
    let answer: JSON
    do {
      answer = try await handler(vector.input)
    } catch {
      answer = ["error": true]
      #expect(vector.expect == answer, "\(vector) threw: \(error)")
      return
    }
    #expect(answer == vector.expect, "\(vector)")
  }

  // The runner counts each settling slice toward `dieAfter`: the vector that dies right after the last chunk, dying one
  // transaction later, leaves one covered entry fewer acked.
  @Test func dieAfterCountsEachSettlingSlice() throws {
    let file = try #require(try Corpus.files().first { $0.path == "pull/pages.json" })
    let vector = try #require(try Corpus.vectors(in: file).first { $0.name.hasPrefix("a process death between settling slices keeps") })
    var input = try vector.input.asObject()
    var steps = try input.member("steps").asArray()
    let index = try #require(steps.firstIndex { $0["dieAfter"] == 1 })
    var step = try steps[index].asObject()
    step["dieAfter"] = 2
    steps[index] = .object(step)
    input["steps"] = .array(steps)
    let answer = try ClientSteps.run(.object(input), registry: Handlers.probe) { PlannedDevice($0, registry: Handlers.probe, limits: $1) }
    #expect(try answer.member("returns").asArray()[index] == [["scope": "self/probe", "outcome": "unsettled"]])
    let outbox = try answer.member("device").member("replicas").asArray()[0].member("outbox").asArray()
    #expect(try outbox.map { "\(try $0.member("localId").asString()) \(try $0.member("state").asString())" } == ["g3/0 acked"])
  }

  @Test func everyCorpusFileHasAHandler() throws {
    #expect(try Corpus.files().filter { $0.role != .cppOnly && Handlers.table[$0.path] == nil }.map(\.path) == [])
  }

  // The transcript runner is no easier than the transcript: a line or an ending the engines do not meet is reported,
  // and a transcript that lost its end or names a device the header does not hold is refused.
  @Test(arguments: ["frame returns", "pull request", "pull returns", "end store", "no end", "unknown device"])
  func aTranscriptTheEnginesDoNotMeetFails(_ mutation: String) async throws {
    let file = try #require(try Corpus.files().first { $0.path == "protocol/live.jsonl" })
    var lines = try Corpus.vectors(in: file)[0].input.asArray()
    let change = { (index: Int, key: String, value: JSON) in
      var line = try lines[index].asObject()
      line[key] = value
      lines[index] = .object(line)
    }
    switch mutation {
    case "frame returns": try change(try #require(lines.firstIndex { $0["frame"] != nil }), "returns", "pull")
    case "pull request": try change(try #require(lines.lastIndex { $0["http"] == "pull" }), "request", ["scopes": []])
    case "pull returns": try change(try #require(lines.lastIndex { $0["http"] == "pull" }), "returns", [])
    case "end store":
      var devices = try lines[lines.count - 1].member("devices").asObject()
      devices["d2"] = devices["d1"]
      try change(lines.count - 1, "devices", .object(devices))
    case "no end": lines.removeLast()
    default: try change(try #require(lines.firstIndex { $0["frame"] != nil }), "device", "d9")
    }
    let differences: [String]
    do {
      differences = try await Transcripts.differences(lines, registry: Handlers.probe)
    } catch is VectorError {
      #expect(["no end", "unknown device"].contains(mutation))
      return
    }
    #expect(differences != [])
  }

  @Test func everyCorpusFileHasOneRoleAndEveryRoleEntryAFile() throws {
    let paths = try Corpus.paths()
    let unclassified = paths.filter { Corpus.role(of: $0) == nil }
    let stale = Corpus.roles.map(\.entry).filter { entry in
      !paths.contains { $0 == entry || (entry.hasSuffix("/") && $0.hasPrefix(entry)) }
    }
    #expect(unclassified == [])
    #expect(stale == [])
    #expect(Corpus.role(of: "gym/admit.json") == .server)
    #expect(Corpus.role(of: "gym/backfill.json") == .cppOnly)
    #expect(Corpus.role(of: "gym/metadata.json") == .cppOnly)
    #expect(Corpus.role(of: "gym/unclaimed.json") == nil)
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
