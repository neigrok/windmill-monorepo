import Network

// `Network` is on §2.3's list of Apple frameworks; the manifest aliases SyncStore to it.
func storePath() -> String { Store(path: "/tmp/replica.sqlite").path }
