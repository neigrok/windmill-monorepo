import SyncCore
import SyncModelServer
import SyncTesting
import Testing

// §6.1 step 2 rules the corpus pins only in part: the integers of an intent.

struct ShapeTests {
  // §9.1 Integers: a number of an `integer` domain, a time field, a time or instant argument and a text base's rev are
  // safe integers, so 2^53 − 1 passes and 2^53 or 1e300 is invalid; a serial is the server's to number (§4.4), so an
  // intent carrying one is invalid, safe or not. The skew bound here lies past 2^53, so only the safe bound refuses.
  @Test func everyIntegerOfAnIntentIsASafeInteger_9_1() throws {
    let registry = try Corpus.probeRegistry()
    let serverNow: Int64 = 9_007_199_254_740_991 - 1_000
    let stamp: JSON = "10:0:r_aaaaaaaaaaaa"
    let intents = { (value: JSON) -> [(intent: JSON, isReplica: Bool)] in
      [
        (["scope": "self/probe", "d": [["t": "run", "id": "run00001", "born": stamp, "f": ["endedAt": [value, .null]]]]], false),
        (["scope": "self/probe", "d": [["t": "lap", "id": "lap00001", "born": stamp, "life": ["alive", stamp],
                                        "f": ["runId": ["run00001", stamp], "at": [value, stamp]]]]], true),
        (["scope": "self/probe", "cmd": ["name": "probe.start", "args": ["id": "run00001", "startedAt": value, "join": false]]], true),
        (["scope": "self/probe", "cmd": ["name": "probe.end", "args": ["runId": "run00001", "endedAt": value]]], true),
        (["scope": "self/overlay/b_00000001", "d": [["t": "mark", "id": "oak", "x": ["memo": ["text": "red", "base": ["rev": value]]]]]],
         true),
        (["scope": "self/probe", "d": [["t": "lap", "id": "lap00001", "born": stamp, "v": ["no": value]]]], false),
      ]
    }
    let refusals = { (value: JSON) -> [RefusalCode?] in
      intents(value).map { intent, isReplica in
        do throws(Refusal) {
          _ = try IntentShape.check(intent, isReplica: isReplica, registry: registry, serverNow: serverNow)
          return nil
        } catch {
          return error.code
        }
      }
    }
    #expect(refusals(9_007_199_254_740_991) == [nil, nil, nil, nil, nil, .invalid])
    #expect(refusals(9_007_199_254_740_992) == [.invalid, .invalid, .invalid, .invalid, .invalid, .invalid])
    #expect(refusals(1e300) == [.invalid, .invalid, .invalid, .invalid, .invalid, .invalid])
  }
}
