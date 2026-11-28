import Foundation
import CryptoKit
import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite(.timeLimit(.minutes(1))) @MainActor struct AiLiveTests {
  @Test func everyLiveTerminalEndsItsSessionWithTheMessageItCarries() async throws {
    let wire = try Self.wire()
    let events = try wire.field("liveEvents").array
    for (name, terminal) in try wire.field("liveTerminals").asObject().members {
      let socket = PlayedSocket([events[0], events[1], events[2]].map { .success(.text($0.jcsText)) })
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                   diagnostics: diagnostics, credentials: { _ in AiCredentials(session: "session") })
      guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                      seat: Seat(kind: .bound, key: "seat"), livenessMs: 2_000) else {
        Issue.record("\(name): the session did not start"); continue
      }
      #expect(connection.remainingSeconds == Int(try events[0].field("remainingSeconds").integer))
      try connection.send(audio: [UInt8](repeating: 1, count: 4_800))
      connection.commit()
      #expect(try await connection.next() == .text(turn: Int(try events[1].field("turn").integer), delta: try events[1].field("delta").string))
      #expect(try await connection.next() == .turn(turn: Int(try events[2].field("turn").integer), text: try events[2].field("text").string))
      connection.end()
      socket.play(.text(terminal.jcsText))
      #expect(try await connection.next() == .end(try Self.end(terminal)), "\(name)")
      #expect(try await connection.next() == .end(try Self.end(terminal)), "\(name)")
      #expect(socket.closed)
      #expect(socket.sent == [.binary([UInt8](repeating: 1, count: 4_800)), .text(try wire.field("liveFrames").array[1].jcsText),
                              .text(try wire.field("liveFrames").array[2].jcsText)])
      #expect(diagnostics.reports == (name == "invalid_request" ? ["ai-live/refusal"] : []), "\(name)")
    }
  }

  @Test func everyFirstFailureEndsTheOpeningWithItsCode() async throws {
    let wire = try Self.wire()
    let fixtures = try wire.field("liveFirstFailures").asObject().members.map { ($0.key, $0.value) }
    let admissions = try ["subject_exhausted", "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted", "rate_limited", "busy",
                          "paused", "device_bound", "conflict", "invalid_request"].map {
      ($0, try wire.field("liveFirstFailures").field("funding_required").changed(["code"], to: .string($0)))
    }
    for (name, failure) in fixtures + admissions {
      let socket = PlayedSocket([.success(.text(failure.jcsText))])
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                   diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                              seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000)
      guard case .failed(let end) = opening else { Issue.record("\(name): \(opening)"); continue }
      #expect(end == (try Self.end(failure)), "\(name)")
      #expect(socket.closed)
      #expect(socket.sent == [])
      #expect(socket.pings.isEmpty)
      #expect(diagnostics.reports == (["conflict", "invalid_request"].contains(name) ? ["ai-live/refusal"] : []), "\(name)")
    }
  }

  @Test func eachServiceMessageIsOneWholeWebSocketMessage() async throws {
    let wire = try Self.wire()
    let started = try wire.field("liveEvents").array[0]
    let text = try wire.field("liveEvents").array[1].jcsText
    let defects: [(String, AiSocketFrame)] = [
      ("half a message", .text(String(text.prefix(text.count / 2)))),
      ("a binary message", .binary(Array(text.utf8))),
      ("a second started", .text(started.jcsText)),
      ("an unnamed field", .text(try wire.field("liveEvents").array[1].changed(["language"], to: "en").jcsText)),
      ("turn zero", .text(try wire.field("liveEvents").array[1].changed(["turn"], to: 0).jcsText)),
      ("a charge on a completed end", .text(try wire.field("liveTerminals").field("completed").changed(["charged"], to: 1).jcsText)),
      ("a completed end with a code", .text(try wire.field("liveTerminals").field("completed").changed(["code"], to: "idle").jcsText)),
      ("a cut with no code", .text(try wire.field("liveTerminals").field("idle").changed(["code"], to: .null).jcsText)),
      ("a failure with no code", .text(try wire.field("liveTerminals").field("provider_failed").changed(["code"], to: .null).jcsText)),
      ("a code not of the service's form", .text(try wire.field("liveTerminals").field("idle").changed(["code"], to: "Went-Away").jcsText)),
      ("an empty code", .text(try wire.field("liveTerminals").field("provider_failed").changed(["code"], to: "").jcsText)),
    ]
    for (name, frame) in defects {
      let socket = PlayedSocket([.success(.text(started.jcsText)), .success(frame)])
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                   diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                      seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
        Issue.record("\(name): the session did not start"); continue
      }
      #expect(try await connection.next() == .lost(.wire), "\(name)")
      #expect(socket.closed, "\(name)")
      #expect(diagnostics.reports == ["ai-live/wire"], "\(name)")
    }
    let refused = wire.field("liveFirstFailures").field("funding_required")
    for (name, first) in [("another call", try started.changed(["callId"], to: "bcdefghijklmnopqrstuvw")),
                          ("a text first", try wire.field("liveEvents").array[1]), ("a negative budget", try started.changed(["remainingSeconds"], to: -1)),
                          ("a charged first failure", try refused.changed(["charged"], to: "0")),
                          ("a first failure that heard audio", try refused.changed(["seconds"], to: 1)),
                          ("a first failure with words", try refused.changed(["text"], to: "Hello")),
                          ("an ended first", wire.field("liveTerminals").field("completed"))] {
      let socket = PlayedSocket([.success(.text(first.jcsText))])
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                   diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                              seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000)
      guard case .refused(let failure) = opening else { Issue.record("\(name): \(opening)"); continue }
      #expect(failure.source == .wire)
      #expect(failure.code == "invalid-answer")
      #expect(socket.closed)
      #expect(diagnostics.reports == ["ai-live/wire"], "\(name)")
    }
  }

  @Test func aTerminalWithACodeTheClientDoesNotKnowStillDeliversItsWords() async throws {
    let wire = try Self.wire()
    let started = try wire.field("liveEvents").array[0]
    let terminals = try [wire.field("liveTerminals").field("idle").changed(["code"], to: "conflict"),
                         wire.field("liveTerminals").field("idle").changed(["code"], to: "invalid_request"),
                         wire.field("liveTerminals").field("idle").changed(["code"], to: "budget_closed"),
                         wire.field("liveTerminals").field("provider_failed").changed(["code"], to: "provider_hiccup")]
    for terminal in terminals {
      let socket = PlayedSocket([.success(.text(started.jcsText)), .success(.text(terminal.jcsText))])
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                   diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                      seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
        Issue.record("The session did not start"); continue
      }
      #expect(try await connection.next() == .end(try Self.end(terminal)))
      #expect(diagnostics.reports == ["ai-live/code"])
      let reader = PolicyDiagnostics()
      let reading = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass")), .success(ValidationTransport.json(terminal))]),
                                    clock: LiveClock(), diagnostics: reader, credentials: { _ in AiCredentials() })
      #expect(try await reading.liveResult(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                           seat: Seat(kind: .anon, key: "seat")) == .answered(try Self.end(terminal)))
      #expect(reader.reports == ["ai-call/code"])
    }
    let first = try wire.field("liveFirstFailures").field("funding_required").changed(["code"], to: "new_refusal")
    let socket = PlayedSocket([.success(.text(first.jcsText))])
    let diagnostics = PolicyDiagnostics()
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                 diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                            seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000)
    guard case .failed(let end) = opening else { Issue.record("\(opening)"); return }
    #expect(end == (try Self.end(first)))
    #expect(diagnostics.reports == ["ai-live/code"])
  }

  @Test func aTerminalTheSocketAlreadyHoldsIsNeverReplacedByLost() async throws {
    let wire = try Self.wire()
    let events = try wire.field("liveEvents").array
    let cut = wire.field("liveTerminals").field("idle")
    let socket = PlayedSocket([events[0], events[1], cut].map { .success(.text($0.jcsText)) })
    let clock = LiveClock()
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: clock,
                                 diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials() })
    guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                    seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
      Issue.record("The session did not start"); return
    }
    await Self.yields { connection.finished }
    clock.advance(to: 60_000)
    await Self.yields { false }
    #expect(try await connection.next() == .text(turn: 1, delta: try events[1].field("delta").string))
    #expect(try await connection.next() == .end(try Self.end(cut)))
    #expect(socket.closed)
  }

  @Test func readersShareOneStreamInTheOrderTheyAsked() async throws {
    let wire = try Self.wire()
    let events = try wire.field("liveEvents").array
    let completed = wire.field("liveTerminals").field("completed")
    let socket = PlayedSocket([.success(.text(events[0].jcsText))])
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                 diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials() })
    guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                    seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
      Issue.record("The session did not start"); return
    }
    let first = Task { try await connection.next() }
    await Self.yields { connection.readers.count == 1 }
    let second = Task { try await connection.next() }
    await Self.yields { connection.readers.count == 2 }
    let third = Task { try await connection.next() }
    await Self.yields { connection.readers.count == 3 }
    socket.play(.text(events[1].jcsText))
    await Self.yields { connection.readers.count == 2 }
    socket.play(.text(events[2].jcsText))
    await Self.yields { connection.readers.count == 1 }
    socket.play(.text(completed.jcsText))
    #expect(try await first.value == .text(turn: 1, delta: try events[1].field("delta").string))
    #expect(try await second.value == .turn(turn: 1, text: try events[2].field("text").string))
    #expect(try await third.value == .end(try Self.end(completed)))
    #expect(try await connection.next() == .end(try Self.end(completed)))
  }

  @Test func aTurnSettlesAfterTheNextTurnsTextBegan() async throws {
    let wire = try Self.wire()
    let events = try wire.field("liveEvents").array
    let script = try [events[0], events[1], events[1].changed(["turn"], to: 2), events[2], events[2].changed(["turn"], to: 2),
                      wire.field("liveTerminals").field("completed")]
    let socket = PlayedSocket(script.map { .success(.text($0.jcsText)) })
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                 diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials() })
    guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                    seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
      Issue.record("The session did not start"); return
    }
    var messages: [AiLiveMessage] = []
    for _ in 0..<5 { messages.append(try await connection.next()) }
    let delta = try events[1].field("delta").string, text = try events[2].field("text").string
    #expect(messages == [.text(turn: 1, delta: delta), .text(turn: 2, delta: delta), .turn(turn: 1, text: text), .turn(turn: 2, text: text),
                         .end(try Self.end(script[5]))])
  }

  @Test func anUpgradeRefusedForItsPassTriesOnceMoreWithANewPass() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    let socket = PlayedSocket([.success(.text(started.jcsText))])
    let diagnostics = PolicyDiagnostics()
    let door = PlayedLiveDoor([.success(Self.pass("first")), .success(Self.pass("second"))], upgrades: [.refused(status: 401), .open(socket)])
    let client = ServiceAiClient(transport: door, clock: LiveClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials(session: "session") })
    let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                            seat: Seat(kind: .bound, key: "seat"), livenessMs: 2_000)
    guard case .started = opening else { Issue.record("\(opening)"); return }
    #expect(door.requests.map(\.path) == ["/v1/ai/passes", "/v1/ai/passes"])
    #expect(door.upgraded.map(\.headers) == [["Authorization": "Bearer first"], ["Authorization": "Bearer second"]])
    #expect(diagnostics.reports == [])
  }

  @Test func anUpgradeRefusedTwiceOrMalformedIsADefectAndAnyOtherStatusIsLost() async throws {
    let cases: [(upgrades: [AiUpgrade], code: String?, loss: AiLiveLoss?, reports: [String])] = [
      ([.refused(status: 401), .refused(status: 401)], "invalid-answer", nil, ["ai-live/wire"]),
      ([.refused(status: 400)], "invalid_request", nil, ["ai-live/wire"]),
      ([.refused(status: 302)], "invalid-answer", nil, ["ai-live/wire"]),
      ([.refused(status: 308)], "invalid-answer", nil, ["ai-live/wire"]),
      ([.refused(status: 502)], nil, .refused(status: 502), []),
      ([.refused(status: 404)], nil, .refused(status: 404), []),
      ([.refused(status: 426)], nil, .refused(status: 426), []),
    ]
    for (upgrades, code, loss, reports) in cases {
      let diagnostics = PolicyDiagnostics()
      let door = PlayedLiveDoor([.success(Self.pass("first")), .success(Self.pass("second"))], upgrades: upgrades)
      let client = ServiceAiClient(transport: door, clock: LiveClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                              seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000)
      switch opening {
      case .refused(let failure): #expect(failure.code == code); #expect(failure.source == .wire)
      case .lost(let reason): #expect(reason == loss)
      default: Issue.record("\(opening)")
      }
      #expect(door.upgraded.count == upgrades.count)
      #expect(door.requests.count == upgrades.count)
      #expect(diagnostics.reports == reports)
    }
  }

  @Test func thePassDoorsAnswerEndsTheOpeningBeforeAnyUpgrade() async throws {
    let cases: [(reply: Result<AiResponse, AiTransportFailure>, code: String?, loss: AiLiveLoss?, reports: [String])] = [
      (.success(ValidationTransport.json(["error": "Update", "code": "client-update-required"], status: 426)), "client-update-required", nil, []),
      (.success(ValidationTransport.json(["error": "Sign in", "code": "unauthenticated"], status: 401)), "unauthenticated", nil, []),
      (.success(ValidationTransport.json(["pass": "", "expiresIn": 600000])), "invalid-answer", nil, ["ai-pass/wire"]),
      (.failure(.offline), nil, .offline, []),
      (.failure(.transport), nil, .transport, ["ai-pass/transport"]),
    ]
    for (reply, code, loss, reports) in cases {
      let diagnostics = PolicyDiagnostics()
      let door = PlayedLiveDoor([reply])
      let client = ServiceAiClient(transport: door, clock: LiveClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                              seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000)
      switch opening {
      case .refused(let failure): #expect(failure.code == code)
      case .lost(let reason): #expect(reason == loss)
      default: Issue.record("\(opening)")
      }
      #expect(door.upgraded.isEmpty)
      #expect(diagnostics.reports == reports)
    }
  }

  @Test func aConnectionThatClosesOrFailsWithoutItsLastMessageIsLost() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    for (end, loss, reports) in [(Result<AiSocketFrame?, AiTransportFailure>.success(nil), AiLiveLoss.closed, [String]()), (.failure(.offline), .offline, []),
                                 (.failure(.transport), .transport, ["ai-live/transport"])] {
      let socket = PlayedSocket([.success(.text(started.jcsText)), end])
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                   diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                      seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
        Issue.record("The session did not start"); continue
      }
      #expect(try await connection.next() == .lost(loss))
      try connection.send(audio: [0, 0])
      connection.commit()
      #expect(try await connection.next() == .lost(loss))
      #expect(socket.closed)
      #expect(socket.sent == [])
      #expect(diagnostics.reports == reports)
    }
    let socket = PlayedSocket([.success(nil)])
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                 diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials() })
    let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                            seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000)
    guard case .lost(.closed) = opening else { Issue.record("\(opening)"); return }
  }

  @Test func audioWaitingToBeSentForLivenessLosesTheConnection() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    let socket = PlayedSocket([.success(.text(started.jcsText))])
    socket.holdsAudio = true
    let clock = LiveClock()
    let diagnostics = PolicyDiagnostics()
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: clock,
                                 diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                    seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
      Issue.record("The session did not start"); return
    }
    await Self.yields { socket.pings.count == 1 }
    try #require(socket.pings.count == 1)
    socket.pings[0]()
    clock.advance(to: 300)
    try connection.send(audio: [UInt8](repeating: 2, count: 4_800))
    socket.held.removeFirst()()
    clock.advance(to: 500)
    try connection.send(audio: [UInt8](repeating: 3, count: 4_800))
    clock.advance(to: 2_000)
    await Self.yields { socket.pings.count == 2 }
    try #require(socket.pings.count == 2)
    socket.pings[1]()
    await Self.yields { clock.sleepers.map(\.deadline) == [2_500] }
    #expect(clock.sleepers.map(\.deadline) == [2_500])
    clock.advance(to: 2_499)
    await Self.yields { connection.finished }
    #expect(!connection.finished)
    clock.advance(to: 2_500)
    await Self.yields { connection.finished }
    try #require(connection.finished)
    #expect(try await connection.next() == .lost(.backlog))
    #expect(socket.closed)
    #expect(socket.sent == [.binary([UInt8](repeating: 2, count: 4_800)), .binary([UInt8](repeating: 3, count: 4_800))])
    #expect(socket.pings.count == 2)
    #expect(diagnostics.reports == [])
  }

  @Test func aPingUnansweredForLivenessLosesTheConnectionAndNoPingFollowsEnd() async throws {
    let wire = try Self.wire()
    let started = try wire.field("liveEvents").array[0]
    for answered in [false, true] {
      let socket = PlayedSocket([.success(.text(started.jcsText))])
      let clock = LiveClock()
      let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: clock,
                                   diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials() })
      guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                      seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
        Issue.record("The session did not start"); continue
      }
      await Self.yields { socket.pings.count == 1 }
      try #require(socket.pings.count == 1)
      clock.advance(to: 1_999)
      await Self.yields { connection.finished }
      #expect(!connection.finished)
      if !answered {
        clock.advance(to: 2_000)
        await Self.yields { connection.finished }
        try #require(connection.finished)
        #expect(try await connection.next() == .lost(.ping))
        #expect(socket.closed)
        continue
      }
      socket.pings[0]()
      clock.advance(to: 2_000)
      await Self.yields { socket.pings.count == 2 }
      try #require(socket.pings.count == 2)
      socket.pings[1]()
      connection.end()
      await Self.yields { clock.sleepers.map(\.deadline) == [4_000] }
      clock.advance(to: 10_000)
      await Self.yields { clock.sleepers.map(\.deadline) == [12_000] }
      #expect(clock.sleepers.map(\.deadline) == [12_000])
      #expect(!connection.finished)
      #expect(socket.pings.count == 2)
      socket.play(.text(wire.field("liveTerminals").field("completed").jcsText))
      #expect(try await connection.next() == .end(try Self.end(wire.field("liveTerminals").field("completed"))))
      #expect(socket.sent == [.text(try wire.field("liveFrames").array[2].jcsText)])
    }
  }

  @Test func aSeatChangeFencesTheOpeningAndTheSession() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    let opening = PlayedSocket()
    let openingClient = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(opening)]), clock: LiveClock(),
                                        diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials() })
    let pending = Task {
      try await openingClient.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                       seat: Seat(kind: .anon, key: "old"), livenessMs: 2_000)
    }
    await Self.yields { opening.waiter != nil }
    openingClient.seatWillChange()
    await #expect(throws: HostFailure.self) { try await pending.value }
    #expect(opening.closed)

    let socket = PlayedSocket([.success(.text(started.jcsText))])
    let diagnostics = PolicyDiagnostics()
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                 diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                    seat: Seat(kind: .anon, key: "old"), livenessMs: 2_000) else {
      Issue.record("The session did not start"); return
    }
    let reading = Task { try await connection.next() }
    await Self.yields { socket.waiter != nil }
    #expect(client.pass != nil)
    client.seatWillChange()
    await #expect(throws: HostFailure.self) { try await reading.value }
    await #expect(throws: HostFailure.self) { try await connection.next() }
    try connection.send(audio: [0, 0])
    connection.end()
    #expect(socket.closed)
    #expect(socket.sent == [])
    #expect(client.pass == nil)
    #expect(client.connections.allObjects.isEmpty)
    #expect(diagnostics.reports == [])
  }

  @Test func aConnectionDroppedWithoutCloseClosesItsSocketAndStopsPinging() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    let socket = PlayedSocket([.success(.text(started.jcsText))])
    let clock = LiveClock()
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: clock,
                                 diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials() })
    guard case .started = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                    seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
      Issue.record("The session did not start"); return
    }
    await Self.yields { socket.closed && clock.sleepers.isEmpty }
    #expect(socket.closed)
    let pings = socket.pings.count
    clock.advance(to: 60_000)
    await Self.yields { false }
    #expect(socket.pings.count == pings)
    #expect(pings <= 1)
    #expect(clock.sleepers.isEmpty)
    #expect(client.connections.allObjects.isEmpty)
  }

  @Test func aSeatChangeFencesAFinishedConnectionAfterAnotherOpened() async throws {
    let wire = try Self.wire()
    let started = try wire.field("liveEvents").array[0]
    let first = PlayedSocket([.success(.text(started.jcsText)), .success(.text(wire.field("liveTerminals").field("completed").jcsText))])
    let second = PlayedSocket([.success(.text(try started.changed(["callId"], to: "bcdefghijklmnopqrstuvw").jcsText))])
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(first), .open(second)]), clock: LiveClock(),
                                 diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials() })
    guard case .started(let old) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                             seat: Seat(kind: .anon, key: "old"), livenessMs: 2_000) else {
      Issue.record("The first session did not start"); return
    }
    #expect(try await old.next() == .end(try Self.end(wire.field("liveTerminals").field("completed"))))
    guard case .started = try await client.openLive(callId: "bcdefghijklmnopqrstuvw", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                    seat: Seat(kind: .anon, key: "old"), livenessMs: 2_000) else {
      Issue.record("The second session did not start"); return
    }
    client.seatWillChange()
    await #expect(throws: HostFailure.self) { try await old.next() }
  }

  @Test func aSeatChangeLeavesNoPassReachableThroughAConnection() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    let door = try LoopbackDoor { _, head in
      if head.hasPrefix("POST /v1/ai/passes ") { return .http(LoopbackDoor.response(200, #"{"pass":"MARKER-PASS","expiresIn":600000}"#)) }
      return .socket(protocol: "wm-live.v1", opening: [LoopbackDoor.frame(1, Array(started.jcsText.utf8))], closing: [])
    }
    let transport = try AiURLSessionTransport(origin: URL(string: "http://127.0.0.1:\(door.port)")!, allowLoopbackHTTP: true)
    let client = ServiceAiClient(transport: transport, clock: LiveClock(), diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials(session: "session") })
    let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                            seat: Seat(kind: .bound, key: "old"), livenessMs: 2_000)
    guard case .started(let connection) = opening else { Issue.record("\(opening)"); return }
    let socket = try #require(connection.socket as? AiURLSessionSocket)
    #expect(socket.task?.originalRequest?.value(forHTTPHeaderField: "Authorization") == "Bearer MARKER-PASS")
    client.seatWillChange()
    #expect(connection.socket == nil)
    #expect(socket.task == nil)
    #expect(client.pass == nil)
    var dumped = ""
    dump(connection, to: &dumped)
    #expect(!dumped.contains("MARKER-PASS"))
    await #expect(throws: HostFailure.self) { try await connection.next() }
  }

  @Test func aSessionsResultAnswersItsLastMessageOrThatItIsOpenGoneOrUnknown() async throws {
    let wire = try Self.wire()
    let refusals = try Dictionary(uniqueKeysWithValues: wire.field("refusals").array.map { (try $0.field("body").field("code").string, $0) })
    func refusal(_ code: String) throws -> AiResponse {
      ValidationTransport.json(refusals[code]!.field("body"), status: Int(try refusals[code]!.field("status").integer))
    }
    let completed = wire.field("liveTerminals").field("completed")
    let failed = wire.field("liveTerminals").field("provider_failed")
    let cases: [(replies: [AiResponse], result: AiLiveResult)] = [
      ([Self.pass("pass"), ValidationTransport.json(completed)], .answered(try Self.end(completed))),
      ([Self.pass("pass"), ValidationTransport.json(failed)], .answered(try Self.end(failed))),
      ([Self.pass("pass"), try refusal("conflict")], .open),
      ([Self.pass("pass"), try refusal("result_gone")], .gone),
      ([Self.pass("pass"), try refusal("call_unknown")], .unknown),
      ([Self.pass("first"), try refusal("pass_expired"), Self.pass("second"), ValidationTransport.json(completed)], .answered(try Self.end(completed))),
    ]
    for (replies, result) in cases {
      let diagnostics = PolicyDiagnostics()
      let door = PlayedLiveDoor(replies.map { .success($0) })
      let client = ServiceAiClient(transport: door, clock: LiveClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      #expect(try await client.liveResult(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                          seat: Seat(kind: .anon, key: "seat")) == result)
      #expect(door.requests.filter { $0.path != "/v1/ai/passes" }.map(\.path) == Array(repeating: "/v1/calls/abcdefghijklmnopqrstuv/result",
                                                                                         count: replies.count / 2))
      #expect(diagnostics.reports == [])
    }
    let defects: [(reply: AiResponse, code: String, failures: [String])] = [
      (try refusal("rate_limited"), "rate_limited", []),
      (try refusal("pass_signature"), "pass_signature", ["ai-call/wire"]),
      (ValidationTransport.event("ended", completed), "invalid-answer", ["ai-call/wire"]),
      (ValidationTransport.json(try wire.field("liveEvents").array[1]), "invalid-answer", ["ai-call/wire"]),
    ]
    for (reply, code, failures) in defects {
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass")), .success(reply)]), clock: LiveClock(),
                                   diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      do {
        _ = try await client.liveResult(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                        seat: Seat(kind: .anon, key: "seat"))
        Issue.record("\(code) answered")
      } catch let failure as AiFailure { #expect(failure.code == code) }
      #expect(diagnostics.reports == failures, "\(code)")
    }
  }

  @Test func audioTheDoorWouldRefuseIsThrownBackUnreportedAndNotSent() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    let socket = PlayedSocket([.success(.text(started.jcsText))])
    let diagnostics = PolicyDiagnostics()
    let client = ServiceAiClient(transport: PlayedLiveDoor([.success(Self.pass("pass"))], upgrades: [.open(socket)]), clock: LiveClock(),
                                 diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    guard case .started(let connection) = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                                                    seat: Seat(kind: .anon, key: "seat"), livenessMs: 2_000) else {
      Issue.record("The session did not start"); return
    }
    for audio in [[], [1], [UInt8](repeating: 0, count: 65_538)] {
      #expect(throws: AiFailure.self) { try connection.send(audio: audio) }
    }
    try connection.send(audio: [UInt8](repeating: 0, count: 65_536))
    #expect(socket.sent == [.binary([UInt8](repeating: 0, count: 65_536))])
    #expect(diagnostics.reports == [])
  }

  @Test func theLiveDoorAndTheResultCarryOnlyThePass() async throws {
    let wire = try Self.wire()
    let socket = PlayedSocket([.success(.text(try wire.field("liveEvents").array[0].jcsText))])
    let door = PlayedLiveDoor([.success(Self.pass("talk")), .success(ValidationTransport.json(wire.field("liveTerminals").field("completed")))],
                              upgrades: [.open(socket)])
    let client = ServiceAiClient(transport: door, clock: LiveClock(), diagnostics: PolicyDiagnostics(),
                                 credentials: { seat in AiCredentials(session: seat.key, installation: "installation") })
    let talk = AiUse(name: "journal.talk", version: 1, label: "talk")
    let seat = Seat(kind: .bound, key: "session")
    guard case .started = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: talk, seat: seat, livenessMs: 2_000) else {
      Issue.record("The session did not start"); return
    }
    _ = try await client.liveResult(callId: "abcdefghijklmnopqrstuv", use: talk, seat: seat)
    #expect(door.requests.map(\.path) == ["/v1/ai/passes", "/v1/calls/abcdefghijklmnopqrstuv/result"])
    #expect(door.requests.map(\.headers) == [
      ["Authorization": "Bearer session", "X-Windmill-Installation": "installation", "Content-Type": "application/json", "Accept": "application/json"],
      ["Authorization": "Bearer talk", "Content-Type": "application/json"],
    ])
    #expect(door.upgraded.map(\.method) == ["GET"])
    #expect(door.upgraded.map(\.path) == ["/v1/calls/abcdefghijklmnopqrstuv/transcription?label=talk"])
    #expect(door.upgraded.map(\.headers) == [["Authorization": "Bearer talk"]])
    #expect(door.upgraded.map(\.body) == [nil])
    #expect(door.subprotocols == ["wm-live.v1"])
  }

  @Test func urlSessionCarriesOnlyThePassToTheLiveDoorAndPlaysItsFrames() async throws {
    let wire = try Self.wire()
    let events = try wire.field("liveEvents").array
    let completed = wire.field("liveTerminals").field("completed")
    let started = Array(events[0].jcsText.utf8)
    let door = try LoopbackDoor { _, head in
      if head.hasPrefix("POST /v1/ai/passes ") { return .http(LoopbackDoor.response(200, #"{"pass":"live-pass","expiresIn":600000}"#)) }
      return .socket(protocol: "wm-live.v1",
                     opening: [LoopbackDoor.frame(1, Array(started[..<9]), fin: false), LoopbackDoor.frame(0, Array(started[9...])),
                               LoopbackDoor.frame(1, Array(events[1].jcsText.utf8)), LoopbackDoor.frame(1, Array(events[2].jcsText.utf8))],
                     closing: [LoopbackDoor.frame(1, Array(completed.jcsText.utf8))])
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpAdditionalHeaders = ["Cookie": "ambient=1", "Authorization": "ambient"]
    configuration.httpCookieStorage?.setCookie(HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "ambient", .value: "1"])!)
    let transport = try AiURLSessionTransport(origin: URL(string: "http://127.0.0.1:\(door.port)")!, configuration: configuration, allowLoopbackHTTP: true)
    let diagnostics = PolicyDiagnostics()
    let client = ServiceAiClient(transport: transport, clock: LiveClock(), diagnostics: diagnostics,
                                 credentials: { _ in AiCredentials(session: "session", installation: "installation") })
    let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                            seat: Seat(kind: .bound, key: "seat"), livenessMs: 2_000)
    guard case .started(let connection) = opening else { Issue.record("\(opening)"); return }
    try connection.send(audio: [UInt8](repeating: 7, count: 4_800))
    connection.commit()
    #expect(try await connection.next() == .text(turn: 1, delta: try events[1].field("delta").string))
    #expect(try await connection.next() == .turn(turn: 1, text: try events[2].field("text").string))
    connection.end()
    #expect(try await connection.next() == .end(try Self.end(completed)))
    let heads = door.heads.map(LoopbackDoor.Head.init)
    #expect(heads.map(\.line) == ["POST /v1/ai/passes HTTP/1.1", "GET /v1/calls/abcdefghijklmnopqrstuv/transcription?label=talk HTTP/1.1"])
    #expect(heads.map { $0.fields["authorization"] } == ["Bearer session", "Bearer live-pass"])
    #expect(heads.map { $0.fields["x-windmill-installation"] } == ["installation", nil])
    #expect(heads.map { $0.fields["cookie"] } == [nil, nil])
    #expect(heads[1].fields["sec-websocket-protocol"] == "wm-live.v1")
    #expect(door.frames.filter { $0.opcode != 9 }.map(\.opcode) == [2, 1, 1])
    #expect(door.frames.filter { $0.opcode != 9 }.map(\.payload) == [[UInt8](repeating: 7, count: 4_800),
      Array(try wire.field("liveFrames").array[1].jcsText.utf8), Array(try wire.field("liveFrames").array[2].jcsText.utf8)])
    #expect(door.frames.filter { $0.opcode == 9 }.count == 1)
    #expect(diagnostics.reports == [])
  }

  @Test func urlSessionReadsARefusedUpgradeByItsStatusAndFollowsNoRedirect() async throws {
    let door = try LoopbackDoor { index, _ in
      switch index {
      case 0: .http(LoopbackDoor.response(401, #"{"code":"pass_expired","allowance":null}"#))
      case 1: .http("HTTP/1.1 302 Found\r\nLocation: /v1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      case 2: .socket(protocol: "wm-other.v1", opening: [], closing: [])
      default: .socket(protocol: nil, opening: [], closing: [])
      }
    }
    let transport = try AiURLSessionTransport(origin: URL(string: "http://127.0.0.1:\(door.port)")!, allowLoopbackHTTP: true)
    let request = AiRequest(method: "GET", path: "/v1/calls/abcdefghijklmnopqrstuv/transcription?label=talk", headers: ["Authorization": "Bearer pass"])
    guard case .refused(status: 401) = try await transport.upgrade(request, subprotocol: "wm-live.v1") else { Issue.record("401 was not a refusal"); return }
    guard case .refused(status: 302) = try await transport.upgrade(request, subprotocol: "wm-live.v1") else { Issue.record("302 was not a refusal"); return }
    await #expect(throws: AiTransportFailure.invalidResponse) { try await transport.upgrade(request, subprotocol: "wm-live.v1") }
    await #expect(throws: AiTransportFailure.invalidResponse) { try await transport.upgrade(request, subprotocol: "wm-live.v1") }
    await #expect(throws: AiTransportFailure.invalidOrigin) {
      try await transport.upgrade(AiRequest(method: "GET", path: "//other.invalid/v1/calls", headers: [:]), subprotocol: "wm-live.v1")
    }
    #expect(door.heads.map { LoopbackDoor.Head($0).line } == Array(repeating: "GET /v1/calls/abcdefghijklmnopqrstuv/transcription?label=talk HTTP/1.1", count: 4))
  }

  @Test func aHandshakeWithAnotherOrNoSubprotocolOrARedirectIsARefusedDefect() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    let answers: [LoopbackDoor.Answer] = [
      .socket(protocol: nil, opening: [LoopbackDoor.frame(1, Array(started.jcsText.utf8))], closing: []),
      .socket(protocol: "wm-other.v1", opening: [LoopbackDoor.frame(1, Array(started.jcsText.utf8))], closing: []),
      .http("HTTP/1.1 302 Found\r\nLocation: /v1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    ]
    for answer in answers {
      let door = try LoopbackDoor { _, head in
        head.hasPrefix("POST /v1/ai/passes ") ? .http(LoopbackDoor.response(200, #"{"pass":"live-pass","expiresIn":600000}"#)) : answer
      }
      let transport = try AiURLSessionTransport(origin: URL(string: "http://127.0.0.1:\(door.port)")!, allowLoopbackHTTP: true)
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: transport, clock: LiveClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials(session: "session") })
      let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                              seat: Seat(kind: .bound, key: "seat"), livenessMs: 2_000)
      guard case .refused(let failure) = opening else { Issue.record("\(opening)"); continue }
      #expect(failure.source == .wire)
      #expect(failure.code == "invalid-answer")
      #expect(diagnostics.reports == ["ai-live/wire"])
      #expect(door.heads.filter { $0.hasPrefix("GET ") }.count == 1)
    }
  }

  @Test func aNetworkDropIsAQuietLossAndAnAbnormalCloseIsReported() async throws {
    let started = try Self.wire().field("liveEvents").array[0]
    let cases: [(LoopbackDoor.Drop, AiLiveLoss, [String])] = [
      (.fin, .offline, []), (.reset, .offline, []), (.close(1000), .closed, []), (.close(1001), .closed, []),
      (.close(1011), .transport, ["ai-live/transport"]), (.close(4000), .transport, ["ai-live/transport"]),
    ]
    for (drop, loss, reports) in cases {
      let door = try LoopbackDoor { _, head in
        if head.hasPrefix("POST /v1/ai/passes ") { return .http(LoopbackDoor.response(200, #"{"pass":"live-pass","expiresIn":600000}"#)) }
        return .socket(protocol: "wm-live.v1", opening: [LoopbackDoor.frame(1, Array(started.jcsText.utf8))], closing: [], then: drop)
      }
      let transport = try AiURLSessionTransport(origin: URL(string: "http://127.0.0.1:\(door.port)")!, allowLoopbackHTTP: true)
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: transport, clock: LiveClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials(session: "session") })
      let opening = try await client.openLive(callId: "abcdefghijklmnopqrstuv", use: AiUse(name: "journal.talk", version: 1, label: "talk"),
                                              seat: Seat(kind: .bound, key: "seat"), livenessMs: 2_000)
      guard case .started(let connection) = opening else { Issue.record("\(drop): \(opening)"); continue }
      #expect(try await connection.next() == .lost(loss), "\(drop)")
      #expect(diagnostics.reports == reports, "\(drop)")
    }
  }

  @Test func aConnectionErrorOfThePosixFamilyIsOffline() {
    for code in [ENOTCONN, ECONNRESET, ECONNABORTED, EPIPE, ENETDOWN, ENETUNREACH, EHOSTDOWN, EHOSTUNREACH, ECONNREFUSED] {
      #expect(AiURLSessionTransport.classify(NSError(domain: NSPOSIXErrorDomain, code: Int(code))) == .offline, "\(code)")
    }
    #expect(AiURLSessionTransport.classify(NSError(domain: NSPOSIXErrorDomain, code: Int(EINVAL))) == .transport)
    #expect(AiURLSessionTransport.classify(URLError(.networkConnectionLost)) == .offline)
    #expect(AiURLSessionTransport.classify(URLError(.badServerResponse)) == .transport)
  }

  @Test func theLiveTypesDescribeThemselvesWithoutWhatTheyCarry() {
    let end = AiLiveEnd(stop: .cut, code: "idle", text: "MARKER-WORD", seconds: 1, charged: "0.123456789", allowance: ["remaining": "MARKER-AMOUNT"])
    let failure = AiFailure(source: .text, code: "subject_exhausted", allowance: ["remaining": "MARKER-AMOUNT"])
    let values: [Any] = [AiLiveMessage.text(turn: 1, delta: "MARKER-WORD"), AiLiveMessage.turn(turn: 1, text: "MARKER-WORD"), AiLiveMessage.end(end),
                         end, AiLiveOpening.failed(end), AiLiveOpening.refused(failure), AiLiveResult.answered(end), failure,
                         AiSocketFrame.text("MARKER-WORD"), AiSocketFrame.binary([0xAB, 0xAB])]
    for value in values {
      var dumped = ""
      dump(value, to: &dumped)
      for text in [String(describing: value), String(reflecting: value), "\(value)", dumped] {
        #expect(!text.contains("MARKER") && !text.contains("0.123456789") && !text.contains("171"), "\(type(of: value))")
      }
    }
    #expect("\(AiLiveMessage.text(turn: 2, delta: "MARKER-WORD"))" == "text(turn: 2, 11 bytes)")
    #expect("\(AiLiveResult.answered(end))" == "answered(cut, code: idle, 11 bytes, 1 s)")
    #expect("\(failure)" == "AiFailure(source: text, code: subject_exhausted, admission: none)")
  }

  static func wire() throws -> JSON {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try JSON(parsing: Array(Data(contentsOf: root.appending(path: "packages/api-contract/ai/wire/fixtures.json"))))
  }

  static func yields(until condition: () -> Bool) async {
    var count = 0
    while !condition(), count < 1_000 {
      await Task.yield()
      count += 1
    }
  }

  static func pass(_ token: String) -> AiResponse { ValidationTransport.json(["pass": .string(token), "expiresIn": 600000]) }

  static func end(_ value: JSON) throws -> AiLiveEnd {
    AiLiveEnd(stop: try value.field("type").string == "failed" ? .failed : #require(AiLiveEnd.Stop(rawValue: value.field("stop").string)),
              code: value.field("code").isNull ? nil : try value.field("code").string, text: try value.field("text").string,
              seconds: Int(try value.field("seconds").integer), charged: value.field("charged").isNull ? nil : try value.field("charged").string,
              allowance: value.field("allowance").isNull ? nil : value.field("allowance"))
  }
}

@MainActor final class PlayedLiveDoor: AiTransport {
  var replies: [Result<AiResponse, AiTransportFailure>]
  var upgrades: [AiUpgrade]
  var requests: [AiRequest] = []
  var upgraded: [AiRequest] = []
  var subprotocols: [String] = []
  init(_ replies: [Result<AiResponse, AiTransportFailure>], upgrades: [AiUpgrade] = []) { self.replies = replies; self.upgrades = upgrades }
  func send(_ request: AiRequest) async throws -> AiResponse {
    requests.append(request)
    guard !replies.isEmpty else { throw AiTransportFailure.invalidResponse }
    return try replies.removeFirst().get()
  }
  func upgrade(_ request: AiRequest, subprotocol: String) async throws -> AiUpgrade {
    upgraded.append(request)
    subprotocols.append(subprotocol)
    guard !upgrades.isEmpty else { throw AiTransportFailure.invalidResponse }
    return upgrades.removeFirst()
  }
}

@MainActor final class PlayedSocket: AiSocket {
  var script: [Result<AiSocketFrame?, AiTransportFailure>]
  var waiter: CheckedContinuation<AiSocketFrame?, Error>?
  var sent: [AiSocketFrame] = []
  var holdsAudio = false
  var held: [@MainActor () -> Void] = []
  var pings: [@MainActor () -> Void] = []
  var closed = false
  init(_ script: [Result<AiSocketFrame?, AiTransportFailure>] = []) { self.script = script }

  func send(_ frame: AiSocketFrame, sent done: @escaping @MainActor () -> Void) {
    sent.append(frame)
    if holdsAudio, case .binary = frame { held.append(done) } else { done() }
  }
  func receive() async throws -> AiSocketFrame? {
    if !script.isEmpty { return try script.removeFirst().get() }
    if closed { return nil }
    return try await withCheckedThrowingContinuation { waiter = $0 }
  }
  func ping(answered: @escaping @MainActor () -> Void) { pings.append(answered) }
  func close() {
    closed = true
    let waiter = waiter
    self.waiter = nil
    waiter?.resume(returning: nil)
  }
  func play(_ frame: AiSocketFrame?) {
    guard let waiter else { return script.append(.success(frame)) }
    self.waiter = nil
    waiter.resume(returning: frame)
  }
}

@MainActor final class LiveClock: AiClock {
  var nowMs: Int64 = 0
  var sleepers: [(id: Int, deadline: Int64, continuation: CheckedContinuation<Void, Error>)] = []
  var sleeperCount = 0
  func wait(ms: Int64) async throws { nowMs += ms }
  func waitUntil(_ deadline: Int64) async throws {
    guard deadline > nowMs else { return }
    let id = sleeperCount
    sleeperCount += 1
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { sleepers.append((id, deadline, $0)) }
    } onCancel: {
      Task { @MainActor in self.wake(id, cancelled: true) }
    }
  }
  func advance(to time: Int64) {
    nowMs = time
    for sleeper in sleepers where sleeper.deadline <= time { wake(sleeper.id, cancelled: false) }
  }
  func wake(_ id: Int, cancelled: Bool) {
    guard let index = sleepers.firstIndex(where: { $0.id == id }) else { return }
    let sleeper = sleepers.remove(at: index)
    if cancelled { sleeper.continuation.resume(throwing: CancellationError()) } else { sleeper.continuation.resume() }
  }
}

final class LoopbackDoor: @unchecked Sendable {
  enum Answer: Sendable {
    case http(String)
    case socket(protocol: String?, opening: [[UInt8]], closing: [[UInt8]], then: Drop = .pump)
  }
  enum Drop: Sendable { case pump, fin, reset, close(UInt16) }
  struct Head {
    let line: String
    let fields: [String: String]
    init(_ text: String) {
      let lines = text.components(separatedBy: "\r\n")
      line = lines[0]
      fields = Dictionary(lines.dropFirst().compactMap { field in
        field.firstIndex(of: ":").map { (field[..<$0].lowercased(), field[field.index(after: $0)...].trimmingCharacters(in: .whitespaces)) }
      }) { first, _ in first }
    }
  }
  let listener: Int32
  let port: UInt16
  let answer: @Sendable (Int, String) -> Answer
  let lock = NSLock()
  var recordedHeads: [String] = []
  var recordedFrames: [(opcode: UInt8, payload: [UInt8])] = []

  init(answer: @escaping @Sendable (Int, String) -> Answer) throws {
    let listener = socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafeMutablePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, length) == 0 && listen(listener, 8) == 0 && getsockname(listener, $0, &length) == 0 }
    }
    guard bound else { close(listener); throw AiTransportFailure.transport }
    self.answer = answer
    self.listener = listener
    port = UInt16(bigEndian: address.sin_port)
    Thread.detachNewThread { [self] in serve() }
  }

  deinit { close(listener) }

  var heads: [String] { lock.withLock { recordedHeads } }
  var frames: [(opcode: UInt8, payload: [UInt8])] { lock.withLock { recordedFrames } }

  func serve() {
    var index = 0
    while true {
      var ready = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
      guard poll(&ready, 1, 30_000) > 0 else { return }
      let client = accept(listener, nil, nil)
      guard client >= 0 else { return }
      var limit = timeval(tv_sec: 10, tv_usec: 0)
      setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
      var noSignal: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
      handle(client, index: index)
      close(client)
      index += 1
    }
  }

  func handle(_ client: Int32, index: Int) {
    var bytes: [UInt8] = []
    while !bytes.suffix(4).elementsEqual(Array("\r\n\r\n".utf8)) {
      guard let byte = Self.read(client, 1) else { return }
      bytes += byte
    }
    let head = String(decoding: bytes.dropLast(4), as: UTF8.self)
    lock.withLock { recordedHeads.append(head) }
    if let length = Head(head).fields["content-length"].flatMap(Int.init), length > 0 { _ = Self.read(client, length) }
    switch answer(index, head) {
    case .http(let response): Self.write(client, Array(response.utf8))
    case .socket(let subprotocol, let opening, let closing, let drop):
      let key = Head(head).fields["sec-websocket-key"] ?? ""
      let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
      Self.write(client, Array(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        + "Sec-WebSocket-Accept: \(accept)\r\n" + (subprotocol.map { "Sec-WebSocket-Protocol: \($0)\r\n" } ?? "") + "\r\n").utf8))
      for frame in opening { Self.write(client, frame) }
      var dropped = false
      while let header = Self.read(client, 2) {
        let opcode = header[0] & 0x0F
        var length = Int(header[1] & 0x7F)
        if length == 126 { guard let wide = Self.read(client, 2) else { return }; length = Int(wide[0]) << 8 | Int(wide[1]) }
        if length == 127 { guard let wide = Self.read(client, 8) else { return }; length = wide.reduce(0) { $0 << 8 | Int($1) } }
        guard let mask = header[1] & 0x80 != 0 ? Self.read(client, 4) : [0, 0, 0, 0], let masked = Self.read(client, length) else { return }
        let payload = masked.enumerated().map { $0.element ^ mask[$0.offset % 4] }
        if opcode == 8 { Self.write(client, Self.frame(8, [])); return }
        lock.withLock { recordedFrames.append((opcode, payload)) }
        if opcode == 9 { Self.write(client, Self.frame(10, payload)) }
        if opcode == 1, payload == Array(#"{"type":"end"}"#.utf8) { for frame in closing { Self.write(client, frame) } }
        guard !dropped else { continue }
        dropped = true
        switch drop {
        case .pump: break
        case .fin: shutdown(client, SHUT_RDWR); return
        case .reset:
          var hold = linger(l_onoff: 1, l_linger: 0)
          setsockopt(client, SOL_SOCKET, SO_LINGER, &hold, socklen_t(MemoryLayout<linger>.size))
          return
        case .close(let code): Self.write(client, Self.frame(8, [UInt8(code >> 8), UInt8(code & 0xFF)]))
        }
      }
    }
  }

  static func response(_ status: Int, _ body: String) -> String {
    "HTTP/1.1 \(status) Answer\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
  }

  static func frame(_ opcode: UInt8, _ payload: [UInt8], fin: Bool = true) -> [UInt8] {
    let first = (fin ? 0x80 : 0) | opcode
    if payload.count < 126 { return [first, UInt8(payload.count)] + payload }
    return [first, 126, UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)] + payload
  }

  static func read(_ client: Int32, _ count: Int) -> [UInt8]? {
    var bytes = [UInt8](repeating: 0, count: count)
    var filled = 0
    while filled < count {
      let received = bytes.withUnsafeMutableBytes { recv(client, $0.baseAddress! + filled, count - filled, 0) }
      guard received > 0 else { return nil }
      filled += received
    }
    return bytes
  }

  static func write(_ client: Int32, _ bytes: [UInt8]) {
    var written = 0
    while written < bytes.count {
      let sent = bytes.withUnsafeBytes { send(client, $0.baseAddress! + written, bytes.count - written, 0) }
      guard sent > 0 else { return }
      written += sent
    }
  }
}
