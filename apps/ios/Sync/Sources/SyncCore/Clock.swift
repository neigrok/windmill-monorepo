// §10 clocks: the replica's hybrid logical clock (§10.2) and its estimate of the server's offset (§10.4).

public struct HLC: Sendable, Hashable {
  public private(set) var ms: Int64
  public private(set) var counter: UInt32

  public init(ms: Int64 = 0, counter: UInt32 = 0) {
    self.ms = ms
    self.counter = counter
  }

  public init(json: JSON) throws {
    let pair = try json.asObject()
    try pair.expectKeys(required: ["ms", "counter"])
    let counter = try pair.member("counter").asInteger()
    guard let counter = UInt32(exactly: counter) else { throw JSONError.shape("a clock counter is below 2^32") }
    self.init(ms: try pair.member("ms").asInteger(), counter: counter)
  }

  public var json: JSON { ["ms": JSON(ms), "counter": JSON(counter)] }

  public mutating func tick(physNow: Int64, actor: Stamp.Actor) -> Stamp {
    if physNow > ms {
      ms = physNow
      counter = 0
    } else if counter == .max {
      ms += 1
      counter = 0
    } else {
      counter += 1
    }
    return Stamp(ms: ms, counter: counter, validActor: actor.text)
  }

  public mutating func observe(_ stamp: Stamp) {
    guard (stamp.ms, stamp.counter) > (ms, counter) else { return }
    ms = stamp.ms
    counter = stamp.counter
  }

  // A clock at a stamp's `(ms, counter)`.
  public init(pairOf stamp: Stamp) {
    self.init(ms: stamp.ms, counter: stamp.counter)
  }

  // The greater `(ms, counter)` pair (§7.7 step 1).
  public static func pairMaximum(_ a: HLC, _ b: HLC) -> HLC {
    (a.ms, a.counter) >= (b.ms, b.counter) ? a : b
  }
}

public struct ServerOffset: Sendable, Hashable {
  public struct Sample: Sendable, Hashable {
    public let offset: Int64
    public let rtt: Int64

    public init(offset: Int64, rtt: Int64) {
      self.offset = offset
      self.rtt = rtt
    }

    // Offset from the wall-clock midpoint (`>> 1` floors it, as every implementation must), round trip in monotonic ms.
    public init?(serverTime: Int64, send: ClockReading, recv: ClockReading) {
      guard !recv.jumped(since: send) else { return nil }
      self.init(offset: serverTime - ((send.wall + recv.wall) >> 1), rtt: recv.mono - send.mono)
    }

    public init(json: JSON) throws {
      let sample = try json.asObject()
      try sample.expectKeys(required: ["offset", "rtt"])
      self.init(offset: try sample.member("offset").asInteger(), rtt: try sample.member("rtt").asInteger())
    }

    public var json: JSON { ["offset": JSON(offset), "rtt": JSON(rtt)] }
  }

  public private(set) var samples: [Sample]
  public private(set) var clockReading: ClockReading?
  public let capacity: Int

  public init(samples: [Sample] = [], clockReading: ClockReading? = nil, capacity: Int = Constants.offsetSamples) {
    self.samples = Array(samples.suffix(capacity))
    self.clockReading = clockReading
    self.capacity = capacity
  }

  // A request that straddles a jump takes no sample; a receipt that jumped from the stored reading drops the earlier ones.
  @discardableResult
  public mutating func take(serverTime: Int64, send: ClockReading, recv: ClockReading) -> Bool {
    guard let sample = Sample(serverTime: serverTime, send: send, recv: recv) else { return false }
    if let clockReading, recv.jumped(since: clockReading) { samples = [] }
    samples = Array((samples + [sample]).suffix(capacity))
    clockReading = recv
    return true
  }

  // `serverOffsetMs`: the lowest round trip among the kept samples, the latest on a tie.
  public var ms: Int64 {
    samples.reversed().min { $0.rtt < $1.rtt }?.offset ?? 0
  }
}

// The device clocks at one moment; two straddle a jump across a reboot or a wall-vs-monotonic drift beyond CLOCK_JUMP_MS.
public struct ClockReading: Sendable, Hashable {
  public let wall: Int64
  public let mono: Int64
  public let boot: String

  public init(wall: Int64, mono: Int64, boot: String) {
    self.wall = wall
    self.mono = mono
    self.boot = boot
  }

  public init(json: JSON) throws {
    let reading = try json.asObject()
    try reading.expectKeys(required: ["wall", "mono", "boot"])
    self.init(
      wall: try reading.member("wall").asInteger(), mono: try reading.member("mono").asInteger(),
      boot: try reading.member("boot").asString())
  }

  public var json: JSON { ["wall": JSON(wall), "mono": JSON(mono), "boot": .string(boot)] }

  public func jumped(since earlier: ClockReading) -> Bool {
    if !boot.utf8.elementsEqual(earlier.boot.utf8) { return true }
    return abs((wall - earlier.wall) - (mono - earlier.mono)) > Constants.clockJumpMs
  }
}
