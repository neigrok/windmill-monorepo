// A product-data clock, independent of the envelope HLC and its skew recovery.
public enum ContentClock {
  public static func valid(_ stamp: JSON) -> Bool {
    guard let fields = try? stamp.asObject(), Set(fields.keys) == ["ms", "counter", "actor"],
          let ms = try? fields.member("ms").asInteger(atLeast: 0), ms < 9_007_199_254_740_992,
          let counter = try? fields.member("counter").asInteger(atLeast: 0), counter < 4_294_967_296,
          let actor = try? fields.member("actor").asString(), actor.utf8.count <= 64,
          actor.utf8.allSatisfy({ $0 >= 32 && $0 <= 126 }) else { return false }
    return !actor.isEmpty || (ms == 0 && counter == 0)
  }

  public static func compare(_ a: JSON, _ b: JSON) -> Int {
    for name in ["ms", "counter"] {
      let x = try! a.member(name).asInteger(), y = try! b.member(name).asInteger()
      if x != y { return x < y ? -1 : 1 }
    }
    let x = Array(try! a.member("actor").asString().utf8), y = Array(try! b.member("actor").asString().utf8)
    return x == y ? 0 : x.lexicographicallyPrecedes(y) ? -1 : 1
  }

  public static func next(pair: JSON? = nil, observed: JSON? = nil, now: Int64, actor: String) throws -> JSON {
    var ms = try pair?["ms"]?.asInteger(atLeast: 0) ?? 0
    var counter = try pair?["counter"]?.asInteger(atLeast: 0) ?? 0
    guard ms < 9_007_199_254_740_992, counter < 4_294_967_296 else { throw JSONError.shape("invalid content clock pair") }
    if let observed {
      guard valid(observed) else { throw JSONError.shape("invalid observed content stamp") }
      let otherMS = try observed.member("ms").asInteger(), otherCounter = try observed.member("counter").asInteger()
      if otherMS > ms || (otherMS == ms && otherCounter > counter) { ms = otherMS; counter = otherCounter }
    }
    if now > ms { ms = now; counter = 0 }
    else { counter += 1; if counter == 4_294_967_296 { ms += 1; counter = 0 } }
    let stamp: JSON = ["ms": JSON(ms), "counter": JSON(counter), "actor": .string(actor)]
    guard !actor.isEmpty, valid(stamp) else { throw JSONError.shape("content clock exhausted or invalid") }
    return stamp
  }

  public static func pair(_ stamp: JSON) -> JSON { ["ms": stamp["ms"]!, "counter": stamp["counter"]!] }
}
