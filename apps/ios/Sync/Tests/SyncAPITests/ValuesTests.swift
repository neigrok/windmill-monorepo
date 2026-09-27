import SyncAPI
import SyncCore
import Testing

// The values products write and read name records, fields, gestures, notices and device rows; each is the same only
// byte for byte, so a canonically equivalent look-alike ("\u{E9}" and "e\u{301}") is always another value.

struct ValuesTests {
  @Test func valuesThatDifferOnlyByCanonicalEquivalenceAreDifferent() throws {
    let names = ["\u{E9}", "e\u{301}"]
    let stamp = try Stamp("1:0:r_aaaaaaaaaaaa")
    let records = names.map { RecordRef(type: $0, id: "r1") }
    let registers = names.map { RegisterRef(type: "card", id: "r1", field: $0) }
    let anchors = names.map { OrderAnchor(field: $0, below: nil) }
    let seeded = names.map { NewID.seeded(seed: $0, ordinal: 1) }
    let derived = names.map { NewID.derived(label: $0) }
    let edits = names.map { TextEdit(text: $0, editedFrom: $0) }
    let changes = names.map { Change.update($0, "r1") }
    let local = names.map { DeviceWrite(key: $0, value: nil) }
    let gestures = names.map { Gesture(changes: [], gestureId: $0) }
    let receipts = names.map { CommitReceipt(gestureId: $0, stamp: stamp, localIds: [$0], ids: [], releaseAt: nil, retired: [$0]) }
    let texts = names.map { TextValue(text: $0, merged: false, pending: false) }
    let read = names.map { name in
      Record(type: name, id: "r1", life: nil, born: nil, values: [:], texts: [:], serials: [:], rc: nil, ru: nil,
             isVisible: true, isPending: false, isHeld: false)
    }
    let notices = names.map { Notice(id: $0, product: $0, scope: .product("p"), code: .cap, detail: nil, content: NoticeContent(), at: 1) }
    let offers = names.map { UndoOffer(id: $0, scope: .product("p"), releaseAt: 1) }
    let counts: [Int] = [
      Set(records).count, Set(registers).count, Set(anchors).count, Set(seeded).count, Set(derived).count, Set(edits).count,
      Set(changes).count, Set(local).count, Set(gestures).count, Set(receipts).count, Set(texts).count, Set(read).count,
      Set(notices).count, Set(offers).count,
    ]
    #expect(counts == [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2])
  }
}
