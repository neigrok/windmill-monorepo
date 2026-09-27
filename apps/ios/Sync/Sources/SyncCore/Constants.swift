// Appendix B and §9.7 values, each the spec's name in Swift spelling (HOLD_MS is `holdMs`).

public enum Constants {
  public static let holdMs: Int64 = 9_000
  public static let leaveDebounceMs: Int64 = 500
  public static let signoutFlushMs: Int64 = 5_000
  public static let maxSkewMs: Int64 = 300_000
  public static let kPoison = 3
  public static let lockTimeoutMs: Int64 = 2_000
  public static let pullFallbackMs: Int64 = 300_000
  public static let backoffBaseMs: Int64 = 1_000
  public static let backoffCeilingMs: Int64 = 300_000
  public static let backoffLiveCeilingMs: Int64 = 30_000
  public static let offsetSamples = 8
  public static let clockJumpMs: Int64 = 1_000
  public static let requestLeaseMs: Int64 = 60_000
  public static let scopeHorizonDays = 30
  public static let replicaGcDays = 365
  public static let requestRetentionDays = 90

  public static let maxRecordBytes = 1_048_576
  public static let pushMaxIntents = 64
  public static let pushMaxBytes = 2_097_152
  public static let pushWorkMs: Int64 = 50
  public static let pullPageBytes = 1_048_576
  public static let pullMaxScopes = 64
  public static let pullMaxBytes = 65_536
  public static let liveFrameBytes = 131_072
  public static let liveInlineBytes = 65_536
  public static let keepaliveBytes = 65_536
  public static let mergeWorkCells = 4_194_304
}
