# Windmill domain kit

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, steps, definitions
(`D-n`), engine requirements (`ER-n`) and invariants (`INV-n`) are numbered so reviews and code can
cite them. "Engine §n" cites [the sync engine](engine.md); "Swift engine" cites the Swift engine
client's design, whose public API the kit binds to.

## §0 Status and scope

**Status:** Built in Swift (`apps/ios/Domain`); Kotlin implements it from this spec. Each
implementation passes the shared vectors of §15. Of §2.1's packages and apps, `WindmillKit` and the
app are not built yet.

**The kit is pure logic.** It is the layer every Windmill feature's domain logic is declared on, on iOS
and Android: §3–§15 and the layering tests of §2. It provides base interfaces and base implementations;
each product declares its own entities, value objects, aggregates, repositories, rules and actions. The
kit names no product concept. Appendices A–C illustrate it; they are not kit content.

**Consumers.** Gym (iOS, Android) and journal (iOS), with the phone Coach. Roadmap is web-only and is
not a kit consumer. Every type the kit writes lives in a product scope (engine D-4), fixed per type.

**Outside the kit:**
- **UI, absolutely.** No SwiftUI, UIKit, AppKit, Combine, Observation, Compose or `android.*`; no
  presentation state, navigation, view models or copy. A product refusal is a value; the UI turns it
  into words.
- **Persistence and networking.** The kit reaches storage and the server only through the engine's
  public API (§17). It owns no table, file, socket or request.
- **Engine algorithms.** Diffing, stamps, id minting, guards, grouping, the commit-time cap and size
  checks, drop positions, holds, retires, folding and the write map stay in the engine (engine §7).
  Quantum rounding and text measures are `SyncCore`'s `Quantum` and `MeasureUnit`, which the kit calls
  (ER-11).
- **Lifecycle.** Sign-in, sign-out, lineage decisions, leaving the app and the Coach turn wire are
  driven by the app shell through the engine.
- **Product rules.** A product's rules, copy and derived reads are the product's, beside its code.

---

## §1 Definitions

**D-1 Kit.** The Swift targets `DomainKit` and `DomainKitNFC` and the Kotlin module `:domain-kit`,
with their test support `DomainKitTesting` and `:domain-kit-testing`.

**D-2 Engine API.** The product-facing surface of the sync engine: Swift `SyncAPI` and Kotlin
`:sync-api` (ER-1) hold `RecordID`, `RecordRef`, `RegisterRef`, `OrderAnchor`, `NewID`, `TextEdit`,
`Change`, `Command`, `DeviceWrite`, `Gesture`, `CommitOutcome`, `CommitReceipt`, `ViewMode`,
`Record`, `Notice`, `UndoOffer`, the `Replica` port and the readers `ScopeReader` and
`CommitContext`. `SyncCore` holds `JSON`, `Stamp`, `ScopeRef`, `Registry`, `RefusalCode`, `Quantum`,
`MeasureUnit` and the engine's `Constants`. `SyncSchema` holds the generated registry and, per
product, its scope and names (`Gym.scope`, `Gym.Types.note`). Together they are the kit's whole lower
boundary.

**D-3 Layer.** One of: engine API, engine runtime, kit, product domain, UI, test, composition (the
app). Each module belongs to exactly one, the row of §2.2 that lists it.

**D-4 Entity.** A product type whose values are records of one registry type (engine D-6, D-7). It
has a typed id and a constructor from a record, and when the client writes it, the fields it writes
and their checks. An entity holds only values; it depends on no helper, repository or engine object.

**D-5 Typed id.** `ID<E>`: a `RecordID` that only an entity of type `E` carries. Ids compare by the
UTF-8 bytes of their string.

**D-6 Fields.** The kit's reader of one record, or of one JSON object inside a record (§3.3).

**D-7 Value object.** A product value with no identity, held inside one of an entity's fields (a
routine entry, a set target). It has a constructor from `Fields`, a JSON encoding and a check.

**D-8 Value spec.** A LOCAL rule on one value, declared as data: text, number, choice or count (§4).
It normalises the value, then checks it. Its name is the registry path of the value it constrains.

**D-9 Check.** One field's LOCAL rules, or a rule on the natural key, as a function of the entity
and the moment (§4.5).

**D-10 Violation.** The first LOCAL rule a value breaks: the rule's name, the path of the value and the
reason (§4.4).

**D-11 Valid.** `Valid<E>`: an entity whose named fields passed their checks. Only its own
initialiser, which runs the checks, constructs one (§4.5).

**D-12 Aggregate.** A root entity and its children: value objects in the root's fields, entities whose
registry `parent` reference names the root, or keyed entities whose key is the root's id. An aggregate
lives in one scope and is loaded in one action's load phase. The kit guarantees the atomicity of one
gesture only: a plan writing several of its records is admitted whole or not at all (INV-3). Records
written by different gestures merge per field (engine §3.2). The kit has no aggregate base type.

**D-13 Rule.** An invariant a product states about its records. Every rule is exactly one of:
- **LOCAL**: its verdict is a function of one register's value (a value object makes coupled values
  one register), or of fields every write path always writes together, and of the moment. No other
  device's write can change it. Every write through the kit satisfies it in the fields it writes.
- **SERVER-DECIDED**: its verdict depends on state that another device, a connected agent or the
  server can change concurrently: caps, one open session, stale edits, whether a record is alive, a
  proposal's state, and every rule across registers written independently. The client **predicts**
  it from `stored`; the server **decides** it at admission; a refusal returns as a notice (engine
  D-17). It declares its refusal codes.

**D-14 Prediction.** The local evaluation of a SERVER-DECIDED rule over `stored`, before commit. A
prediction refuses only a write the server would refuse (INV-6).

**D-15 Rule book.** A product's rules and entity facts, declared in code and pinned byte for byte
across Swift and Kotlin by one JSON file (§6.3).

**D-16 Decider and action.** A decider is a scope, a load phase over a `Reader`, and a pure decide
phase that returns a decision (§9.1). An action is a decider the runner runs: a use case. A draft's
save is a decider and not an action (§10.1).

**D-17 Decision and outcome.** A decision is `write(plan, result)`, `unchanged(result)` or
`refuse(refusal)`. An outcome is what `run` returns: `committed(result, receipt)`,
`unchanged(result)` or `refused(refusal)`. `committed` means committed on this device; it does not
mean the account accepted it.

**D-18 Runner.** `ActionRunner`: the only kit object that holds the `Replica` port. It runs an action
as one engine commit (§9.2). The app composes it.

**D-19 Refused and product refusal.** `Refused` is one refusal as the engine states it: a code, a
subject record, a detail and its path, `predicted` (nothing was written) or `notice` (a write
committed on this device was refused by the server). A product refusal is the product's own type,
built from a `Violation` or a `Refused` by one total mapping (§12).

**D-20 Draft.** An entity being edited: its id, its base (the value it was opened from or a blank,
then what its last save stored) and its current value (§10).

**D-21 Instant, local day, zone, moment.** An instant is integer epoch milliseconds. A local day is a
Gregorian `YYYY-MM-DD` date. A zone maps an instant to its offset from UTC. A moment is an instant
with a zone, and so a local day (§5).

**D-22 Harness.** The deterministic test bed for feature logic: the real engine in step mode over an
in-memory store, a model server, an injected clock and seeded ids (§14).

**D-23 Shared vector.** A JSON case whose expected output every implementation reproduces byte for
byte, compared by JCS (§15).

---

## §2 Layering, enforced

### §2.1 Packages and modules

Placement is normative, and these lists are closed: the layering tests know every package, package
dependency and module (§2.4 item 4), and a name grants nothing. The kit and the product domains live
in a package of their own, apart from the engine's, so the engine's `package`-access internals cannot
reach them.

| Package | Path | Package dependencies | May hold (test targets aside) |
|---|---|---|---|
| `WindmillSync` | `apps/ios/Sync/` | `GRDB.swift` | `SyncCore`, `SyncAPI`, `SyncSchema`, `SyncReplica`, `SyncStore`, `SyncModelServer`, `SyncEngine`, `SyncIOS`, `SyncSchemaGen`, `SyncTesting` |
| `WindmillDomain` | `apps/ios/Domain/` | `WindmillSync`; `swift-syntax` for `LayeringTests` | `DomainKitNFC`, `DomainKit`, `DomainKitTesting`, `GymDomain`, `JournalDomain` |
| `WindmillKit` | `apps/ios/WindmillKit/` | `WindmillDomain`, `WindmillSync` | `WindmillPlatform`, `WindmillGym`, `WindmillJournal` |
| `SyncTestingSurface` | `apps/ios/SyncTestingSurface/` | `WindmillSync`, its `SyncTesting` product only | test targets only |
| the app | `apps/ios/project.yml` | the three packages; remote packages of its own | the app target and its test bundles |
| the probe app | `apps/ios/SyncProbe/project.yml` | `WindmillSync` | the engine's dev and test host over the probe product; never shipped |

Every module is a regular Swift target, except `SyncSchemaGen`, an executable. Remote dependencies are
closed by package identity; the checked-in `Package.resolved` pins their revisions.

| Swift module | Depends on |
|---|---|
| `DomainKitNFC` | — (imports `Foundation`; its whole source is one public function, `nfc(_:)`) |
| `DomainKit` | `DomainKitNFC`, `SyncCore`, `SyncAPI` |
| `DomainKitTesting` | `DomainKit`, `SyncCore`, `SyncAPI`, `SyncEngine`, `SyncTesting` |
| `<P>Domain` | `DomainKit`, `SyncCore`, `SyncAPI`, `SyncSchema` |
| `<P>DomainTests` | `<P>Domain`, `DomainKit`, `DomainKitTesting`, `SyncCore`, `SyncAPI`, `SyncSchema`, `SyncTesting` |
| `Windmill<P>` | `<P>Domain`, `DomainKit`, `SyncCore`, `SyncAPI`, `SyncEngine`, `WindmillPlatform` |

The app injects `SyncSchema.registry` into the runner and the UI modules, which do not import
`SyncSchema`.

The Kotlin modules `:sync-core`, `:sync-api`, `:sync-schema`, `:sync-testing` (ER-10), `:domain-kit`,
`:domain-kit-testing` and `:gym:domain` are `jvm` modules; `:sync-engine`, `:platform`, `:gym` and
`:app` are `android` modules. Each depends as its Swift twin above does, with `:sync-testing` for
`SyncEngine` and `SyncTesting`; `:sync-engine` and `:platform`, with no twin above, follow §2.2.
A Kotlin module `:a:b` lives at `apps/android/a/b`. `settings.gradle.kts` includes exactly these
modules and no other build. A `jvm` module applies exactly the plugin set `{org.jetbrains.kotlin.jvm}`.

### §2.2 The layer rules, in test code

The rules live in the layering tests' code, not in a data file a change could edit beside the
manifest. A test target is in the test layer. Every other module is in the one row that lists it:

| Layer | Swift modules | Kotlin modules | May depend on |
|---|---|---|---|
| composition | the app target | `:app` | anything |
| engine API | `SyncCore`, `SyncAPI`, `SyncSchema` | `:sync-core`, `:sync-api`, `:sync-schema` | engine API |
| engine runtime | `SyncReplica`, `SyncStore`, `SyncModelServer`, `SyncEngine`, `SyncIOS`, `SyncSchemaGen`; `GRDB` | `:sync-engine` | engine API, engine runtime; `GRDB` from `SyncStore` only |
| engine test support | `SyncTesting` | `:sync-testing` | engine API, engine runtime |
| kit | `DomainKit`, `DomainKitNFC` | `:domain-kit` | engine API, kit |
| kit test support | `DomainKitTesting` | `:domain-kit-testing` | kit, engine API, `SyncEngine`, `SyncTesting` |
| product domain | `GymDomain`, `JournalDomain` | `:gym:domain` | kit, engine API |
| platform | `WindmillPlatform` | `:platform` | kit, engine API, `SyncEngine` |
| product UI | `WindmillGym`, `WindmillJournal` | `:gym` | its own product domain, kit, engine API, `SyncEngine`, platform |
| test | test targets; the modules of the package whose identity is `swift-syntax` | test source sets | anything but platform, product UI and composition; `<M>Tests` also `<M>` |

- No product domain depends on another product domain. Platform never depends on a product module,
  and a product UI on no other product's modules.
- The transitive closure of every kit and product-domain module stays inside kit and engine API. A
  dependency on a library product counts as a dependency on every target the product bundles.

### §2.3 What kit, domain and engine-API sources may contain

**Swift.** `LayeringTests` parses each file `dump-package` assigns to a module (§2.4 item 5) with
swift-syntax's `SwiftParser`, whose major version the test checks against the compiler's (602 for
6.2), and applies these rules to its syntax and tokens. Comments and the text inside string and regex
literals are not tokens.

| Module | Imports allowed | Determinism lint |
|---|---|---|
| `DomainKitNFC` | `Foundation` | — (its content is pinned, below) |
| `DomainKit` | `SyncCore`, `SyncAPI`, `DomainKitNFC` | yes |
| `<P>Domain` | `SyncCore`, `SyncAPI`, `SyncSchema`, `DomainKit` | yes |
| `SyncCore` | `CryptoKit`, in its digest file only | — |
| `SyncAPI`, `SyncSchema` | `SyncCore` | — |
| every other non-test module | package modules (of §2.1's packages or a remote package): its declared direct dependencies; SDK modules (any other): any, but the layers below import no UI framework, and only `SyncStore` imports `SQLite3`, `CoreData` or `SwiftData` | — |

- No kit, kit test support, product domain, engine API, engine runtime or engine test support module of
  §2.1's packages imports `SwiftUI`, `UIKit` (`SyncIOS` may), `AppKit`, `Combine` or a framework
  bringing `UIKit` or `AppKit` (`AuthenticationServices`, `StoreKit`, `SafariServices`,
  `LinkPresentation`, `QuickLook`, `PhotosUI`, `MapKit`, `AVKit`, `WebKit`, `PassKit`), or names
  `ObservableObject`, `Published`, `AnyCancellable`, `PassthroughSubject` or `CurrentValueSubject`. An
  `#if` hides no import; a dependency's UI (`GRDB`'s `UIKit`) and unlisted frameworks are not seen.
- In every non-test module of §2.1's packages, an `import` names one module from its row, maybe
  scoped (`import struct M.T`) or with an access level, and carries no attribute.
- In every module the table lists by name, no attribute, directive or macro name begins `_` (`@_spi`,
  `#_hasSymbol`), and none of `#if`, `#elseif`, `#available`, `#unavailable` and `@available` appears.

**The determinism lint**, for `DomainKit` and every product domain, fails on these tokens: `random`,
`randomElement`, `shuffle`, `shuffled`, `SystemRandomNumberGenerator`, `hashValue`, `Hasher` followed
by `(`, `ContinuousClock`, `SuspendingClock`, `continuous`, `suspending`, `CommandLine`, `readLine`,
`print`, `debugPrint`, `dump`, `Task`, `async`, `await`, `MainActor`, `nonisolated`, `@unchecked`,
`finalize`, `ObjectIdentifier`; every identifier beginning `_` (a bare `_` passes), `Unsafe`, `unsafe`
or `withUnsafe`. Tokens match whole, so `CoachThread` passes, and a `hash(into hasher: inout Hasher)`
conformance passes. It is a lint, not a sandbox: it catches the mistakes a feature makes, and
deliberate evasion is out of scope. A token joins the list only for a mistake a feature would make.
Every layering check of §2.4 is held the same way: it guards code and configuration written in good
faith; configuration crafted to hide from it is out of scope, and review catches it.

`LayeringTests` holds one fixture per rule, with its expected findings.

**`DomainKitNFC`** has exactly one source file, whose text equals the constant the test holds:

```swift
import Foundation

public func nfc(_ s: String) -> String { s.precomposedStringWithCanonicalMapping }
```

**Kotlin.** The layering task reads the compiled classes of kit, domain and engine-API modules, both
the Kotlin and the Java output of each main source set. An
*owner* is a class named by a `CONSTANT_Class` entry of a class file's constant pool, or as the owner
of a `Fieldref`, `Methodref` or `InterfaceMethodref` entry, except the `java/lang/invoke/` classes an
`invokedynamic` bootstrap method names, as its owner or in its descriptor (string templates,
lambdas). Descriptors, signatures and annotations name no owner. A member is matched by its owner,
name and descriptor. The task fails on an owner outside this list, a member it denies, a
`monitorenter` instruction, or a `native` method. The owner list enforces the layers; the member
denials, `monitorenter` and `native` are the determinism lint:

| Owner | Allowed | Members denied |
|---|---|---|
| `kotlin/**` | except `kotlin/io`, `kotlin/concurrent`, `kotlin/system`, `kotlin/random`, `kotlin/time`, `kotlin/reflect`, `kotlin/uuid`, `kotlin/coroutines` | `kotlin/math/MathKt`: `pow`, `exp`, `ln`, `log`, `log10`, `log2`; `kotlin/collections/*` and `kotlin/sequences/*`: `shuffled`, `shuffle`, `random`, `randomOrNull` |
| `java/lang/` | `Object`, `String`, `CharSequence`, `StringBuilder`, `Comparable`, `Enum`, `Iterable`, `Number`, the boxed primitives, `Math`, `Class`, `Throwable` and the `*Exception` and `*Error` classes; `Thread` in the kit's `Draft` and `ActionRunner` classes only | every `Thread` member but `currentThread`; `Object.wait`, `notify`, `notifyAll`; `String.format`, `formatted`, and `toUpperCase` and `toLowerCase` with descriptor `()Ljava/lang/String;` (the `(Ljava/util/Locale;)` forms that `uppercase()` and `lowercase()` emit pass); the boxed types' `getInteger`, `getLong`, `getBoolean`; `Throwable.printStackTrace`; every member of `Class`; every `Math` member but `abs`, `min`, `max`, `floor`, `ceil`, `rint`, `round`, `sqrt`, `signum`, `copySign`, `floorDiv`, `floorMod` and the `*Exact` family |
| `java/util/` | the collection interfaces, `ArrayList`, `LinkedHashMap`, `LinkedHashSet`, `Comparator`, `Locale` | every member of `Locale` but the field `ROOT` |
| `java/text/Normalizer` | in the kit's NFC class only, which declares one method | — |
| the module's own packages and its allowed dependencies' | yes | — |

Kotlin does not check global mutable state (an `object` holding a `var`); a domain holds none
(§9.1).

### §2.4 Enforcement

1. **Declared edges (compile time).** Every `swift build` and `swift test` of `WindmillSync`,
   `WindmillDomain`, `WindmillKit` and `SyncTestingSurface` runs with
   `--explicit-target-dependency-import-check error`, in CI and in each package's README command. It
   checks only that an import lies in the module's transitive closure; §2.3's import rule checks the
   edge. A domain's own UI module is a dependency cycle and never compiles.
2. **Plain JVM (compile time).** Kit, domain and engine-API Kotlin modules are `jvm` modules, so
   `android.*` does not compile in them.
3. **Settings (compile time).** The four packages of §2.1 declare tools version 6.2 or later and
   Swift language mode 6 only, so global mutable state is a compile error. Every non-test target's
   settings are exactly these, with no condition and no plugin:
   - `DomainKit`, every product domain, `SyncCore`, `SyncAPI` and `SyncSchema`:
     `[.enableUpcomingFeature("MemberImportVisibility")]`, so a Foundation member cannot be called
     from a file that does not import Foundation;
   - every `WindmillKit` target: `[.defaultIsolation(MainActor.self), .treatAllWarnings(as: .error),
     .treatWarning("DeprecatedDeclaration", as: .warning)]`, so UI code is main-actor code and a capture
     that crosses an isolation domain does not compile, while an SDK deprecation stays a warning;
   - every other target: `[]`; a UI module's test target MAY take `.defaultIsolation(MainActor.self)`.

   Every target and configuration of each app project of §2.1, the probe app's included, resolves,
   for `iphoneos` and `iphonesimulator`, `SWIFT_VERSION` 6.0, `SWIFT_TREAT_WARNINGS_AS_ERRORS` YES,
   `SWIFT_WARNINGS_AS_WARNINGS_GROUPS` `DeprecatedDeclaration`, `SWIFT_DEFAULT_ACTOR_ISOLATION`
   `MainActor` for its app target, and no `OTHER_SWIFT_FLAGS`, `SWIFT_EXEC`,
   `SWIFT_USE_INTEGRATED_DRIVER` or `TOOLCHAINS` of its own. Each target sets those values in its
   `project.yml`, literally, and nothing else sets a pinned key: no `[…]` condition, no `$(…)`, no
   xcconfig. A project has no build rule; no script phase compiles Swift.
4. **Closed world, read from the resolved build.** The checks read what the build tool resolved,
   never source text, so anything the build compiles is scanned:
   - A package holds one manifest, `Package.swift`, and no `Package@swift-*.swift`. It is constant
     data: `import PackageDescription`, top-level `let` bindings and one `Package(…)`, built only of
     literals, PackageDescription calls with no `moduleAliases`, `MainActor.self` and those lets.
     SwiftParser checks it with backticks stripped: no other declaration, statement, branch, operator,
     closure, interpolation or identifier, so no `Context`, `CommandLine`, environment or file read.
   - `LayeringTests` then reads each package as `swift package dump-package` resolves it, and each
     app project as `xcodegen` generates it and `xcodebuild -showBuildSettings` resolves every target
     in every configuration; an app names only the packages its §2.1 row lists.
   - It fails when a package, package dependency, module or module kind is not §2.1's, or lives
     elsewhere than §2.1 places it; when an edge breaks §2.2 or a closure leaves kit and engine API;
     when a target's settings, plugins or language modes differ from item 3; and when any path under a
     package but its `.build` and `.swiftpm` is a symbolic link.
   - It reads `.github/workflows/ios*.yml`: an `xcodebuild` or `swift` invocation written there
     passes only build settings the test lists, no `-xcconfig` and no `-Xswiftc`, and no step sets
     `XCODE_XCCONFIG_FILE`. A developer's own build environment is out of scope.

   Kotlin's `layering` task is a dependency of `check` and of every variant's `preBuild`, so it reads
   the project model of each build that ships: every project, its directory and its dependencies. It
   fails when a project is not §2.1's or lives elsewhere; when the build includes another build or a
   `sourceControl` source (a `pluginManagement` build of convention plugins is allowed); when a
   project edge breaks §2.2; when a plugin set differs from `{org.jetbrains.kotlin.jvm}`; or when the
   resolved compile or runtime classpath of a kit or domain module holds anything but listed projects,
   `kotlin-stdlib` and `org.jetbrains:annotations`, so no prebuilt jar or class directory.
5. **Source and class scans.** `LayeringTests` applies §2.3's Swift rules to the files `dump-package`
   assigns to each module (its `path`, `sources` and `exclude`), pins `DomainKitNFC`, and runs its
   fixtures; a module §2.3 names that the scan did not read fails. The `layering` task applies §2.3's
   class rules to what a kit or domain module ships (`runtimeElements`), not only to what it compiles.
6. **CI.** The layering tests are part of `swift test` and `./gradlew check`, which `ios.yml` and
   `android.yml` run on every push and pull request touching `apps/` or `packages/api-contract/`.

---

## §3 Entities and records

### §3.1 The entity interfaces

```swift
public protocol Entity: Sendable {
  static var type: String { get }                  // the registry type, from SyncSchema
  static var scope: ScopeRef { get }               // its product scope, from SyncSchema
  var id: ID<Self> { get }
  init(_ record: Fields) throws(DecodeError)
}
public protocol Writable: Entity {
  var fields: [String: JSON] { get }               // every field the client writes; nil as JSON null
  static var checks: [Check<Self>] { get }         // in the order violations are reported
}
public protocol Removable: Entity { static var heldRemoval: Bool { get } }
public protocol Ordered: Entity { static var orderField: String { get } }
public protocol Draftable: Writable { static var savesGuarded: Bool { get } }
public protocol Timestamped: Draftable { static var timestampField: String { get } }

public struct ID<E: Entity>: Hashable, Comparable, Sendable {
  public let record: RecordID
  public init(_ record: RecordID)
  public init(_ day: LocalDay)                     // a key that is a local date (§5.3)
  public var day: LocalDay? { get }
  public var ref: RecordRef { get }
  public var json: JSON { get }
  public static func < (a: ID, b: ID) -> Bool      // UTF-8 bytes
}
```

```kotlin
interface Entity<E : Entity<E>> { val id: Id<E> }
interface Writable<E : Writable<E>> : Entity<E> { fun fields(): Map<String, Json> }
interface EntityType<E : Entity<E>> {                             // the entity's companion object
    val type: String
    val scope: ScopeRef
    fun decode(f: Fields): E
}
interface WritableType<E : Writable<E>> : EntityType<E> { val checks: List<Check<E>> }
interface RemovableType<E : Entity<E>> : EntityType<E> { val heldRemoval: Boolean }
interface OrderedType<E : Entity<E>> : EntityType<E> { val orderField: String }
interface DraftType<E : Writable<E>> : WritableType<E> { val savesGuarded: Boolean }
interface TimestampedType<E : Writable<E>> : DraftType<E> { val timestampField: String }
@JvmInline value class Id<E>(val record: RecordId) { constructor(day: LocalDay) : this(RecordId(day.text)) }
```

Kotlin follows every Swift signature in this spec by these conventions: static requirements are
members of the entity's companion object; a typed `throws(Violation)` is a thrown `Violation`; an
optional is a nullable type, and an overload that differs from another only in that carries its own
`@JvmName`; `inout` is a returned copy.

**The developer declares** per entity: its type and scope, its stored properties, its constructor
from `Fields`, and when written, `fields` and `checks`.

Rules:
- An entity is a value type (Swift `struct`, Kotlin `data class`) whose stored properties are values.
  Two entities are compared by their `fields` (JCS); synthesized `Equatable` is not used.
- `fields` lists client-written fields only: registry `writer: client`, kind `lww`, `ranked`, `fww`,
  `const`, `time` or `text`, never `serial`, and never the order field of an `Ordered` entity. A nil
  optional field is JSON `null`.
- A `Draftable` holds only the fields it writes, so decoding a record built from `fields` gives the
  entity back (§3.4 step 7). It reads serial and server-written values from the engine's `Record`, or
  from a second, read-only entity.
- An entity is `Removable` only if its registry type has life and its product binding lets a client
  delete it. `heldRemoval` is true iff the binding holds that delete (engine Appendix A, "Held"),
  as the product's canon lists it among its delete windows (gym: `docs/design/gym/briefs/13-gestures.md`).
- `Ordered.orderField` names a client `lww` field whose domain is `fracKey`.
- `Draftable.savesGuarded` is true iff the binding guards the type's editor save.
- A registry type flagged `wholePut` (engine §2.4) is one fact, saved whole: its entity writes every
  client-written field of the type, and a `Draftable` of it saves unguarded (§10.2 step 1).
- `Timestamped.timestampField` names the field that records each save's own moment: a client `lww`
  field with an integer domain, of a `wholePut` type (engine §7.1 step 4). `Valid` gives it the
  moment's `now` (§4.5), so every write of it inside a run records the commit's now; no check,
  editor or action sets it.

### §3.2 Identity

The entity does not choose engine operations; the kit derives them from the registry type's
identity class (engine D-8, engine §4.1). A new record's id is one of:
- **minted:** `IDSource.mint` in decide, or `ActionRunner.mint` when a draft opens;
- **given:** an id the action receives as input, such as a seeded id a Coach call carries (gym Coach
  G-7) or an offer id pre-minted into a device row;
- **natural:** a keyed type's key, built by the product (`ID(day)`), or a singleton's generated id.

Every plan names resolved ids and translates them as `NewID.given` (INV-10).

### §3.3 Fields

```swift
public struct Fields {
  public init(_ record: Record)
  public init(_ object: JSON) throws(DecodeError)                 // a value object inside a record
  public var id: RecordID { get }                                 // records only
  public func string(_ f: String) throws(DecodeError) -> String
  public func string(_ f: String, default d: String) throws(DecodeError) -> String
  public func optionalString(_ f: String) throws(DecodeError) -> String?
  public func int(_ f: String) throws(DecodeError) -> Int
  public func optionalInt(_ f: String) throws(DecodeError) -> Int?
  public func double(_ f: String) throws(DecodeError) -> Double
  public func optionalDouble(_ f: String) throws(DecodeError) -> Double?
  public func bool(_ f: String) throws(DecodeError) -> Bool
  public func bool(_ f: String, default d: Bool) throws(DecodeError) -> Bool
  public func instant(_ f: String) throws(DecodeError) -> Instant             // any integer-ms field
  public func optionalInstant(_ f: String) throws(DecodeError) -> Instant?
  public func ref<E: Entity>(_ f: String, _ type: E.Type) throws(DecodeError) -> ID<E>
  public func optionalRef<E: Entity>(_ f: String, _ type: E.Type) throws(DecodeError) -> ID<E>?
  public func value<V: ValueObject>(_ f: String, of: V.Type) throws(DecodeError) -> V
  public func optionalValue<V: ValueObject>(_ f: String, of: V.Type) throws(DecodeError) -> V?
  public func list<V: ValueObject>(_ f: String, of: V.Type) throws(DecodeError) -> [V]
  public func optionalList<V: ValueObject>(_ f: String, of: V.Type) throws(DecodeError) -> [V]?
  public func text(_ f: String) -> String                         // a text field; "" when unset
  public func serial(_ f: String) -> Int?                         // confirmed only (engine §7.6)
  public func json(_ f: String) -> JSON?
}
public struct DecodeError: Error, Equatable, Sendable {
  public let type: String, field: String, reason: String
  public init(type: String, field: String, reason: String)
}
```

- A getter throws `DecodeError` when the field is absent and has no default, or holds another JSON
  kind. For a non-optional getter, `null` is absent.
- Decoding accepts every value the registry admits and never applies LOCAL rules: a read is lenient
  to the registry, a write is strict to the checks of the fields it writes (§4). A value another
  writer stored is read as stored.
- Unknown fields are ignored (engine §7.6). A UI that draws a record's pending or held state reads it
  from the engine's `Record`, never from an entity.

### §3.4 Registry agreement

`RegistryCheck.entity(E.self, sample:book:registry:)` (§14.4), run by each product's tests for every
entity, fails unless:
1. the registry declares `E.type` in a product scope whose reference is `E.scope`;
2. `Removable` implies the type has life;
3. `Ordered.orderField` is a client `lww` field with a `fracKey` domain;
4. every key of `sample.fields` is a client-written, non-serial field of the type, and none is the
   order field;
5. every field check's field is a key of `sample.fields`;
6. every LOCAL spec in `book` whose path begins `<E.type>.<f>` has a check on `f`, names a registry
   path, and admits no value the registry refuses there (§4.2);
7. for a `Draftable`, decoding a record built from `sample.fields` gives an entity whose `fields`
   equal `sample.fields` by JCS;
8. a `Draftable` whose `savesGuarded` is true has no `text` field;
9. every registry path of the type with a `quantum`, nested ones included, has a `NumberSpec` in
   `book` whose quantum is on it, so a checked value is the value the store holds;
10. every string path of a field the entity writes (a key of `sample.fields`), a `text` field's and
    each nested one included, has a `TextSpec` or `ChoiceSpec` in `book`, so a pasted U+0000 is a
    `Violation` (§4.3). A field the entity does not write needs none;
11. for a `wholePut` type, `sample.fields` names every client-written field of the type and a
    `Draftable`'s `savesGuarded` is false; a `Timestamped` entity's type is `wholePut`, and its
    `timestampField` a client `lww` integer field of `sample.fields` that no check names.

`RuleBookCheck` (§6.3) then requires an entity case in `values.json` for every LOCAL rule bound to a
field, so the wiring from spec to check to field runs in a vector.

---

## §4 Values

### §4.1 Value objects

```swift
public protocol ValueObject: Sendable {
  init(_ f: Fields) throws(DecodeError)
  var json: JSON { get }
  func validated(at path: Path) throws(Violation) -> Self
}
extension JSON {
  public static func object(omittingNil pairs: [String: JSON?]) -> JSON
  public static func of(_ x: Int?) -> JSON                       // nil → null
  public static func of(_ x: Double?) -> JSON
  public static func of(_ s: String?) -> JSON
  public static func of(_ t: Instant?) -> JSON                   // epoch ms
}
```

```kotlin
interface ValueObject<V : ValueObject<V>> { fun json(): Json; fun validated(at: Path): V }
interface ValueType<V : ValueObject<V>> { fun decode(f: Fields): V }          // its companion object
```

`validated` returns a normalised copy or throws. An absent optional member of a value object is
omitted from its JSON unless the registry domain states `null`.

### §4.2 Value specs

A value spec is data. Its `path` is the registry path of the value it constrains
(`<type>.<field>`, then `.<property>` through nested objects, arrays passed through), and is its rule
name (§6.3). It MUST admit no value the registry refuses at that path: a `chars` bound `m` against a
`bytes` bound needs `4m ≤` it, a `bytes` bound `m` against a `chars` bound needs `m ≤` it, number
bounds lie within the domain, its quantum `q` is on the registry's quantum `Q` (`Quantum(Q).holds(q)`),
and no string it admits holds U+0000. A count spec's `max` is at most the array's `maxItems`, and
`max` items at the item's largest JCS encoding fit the field's bytes bound.

`RegistryCheck` computes each, with two limits. It measures a count's fit only when every part of an
item has a largest encoding; an id, a fractional key, a stamp, raw JSON, or a string with neither a
`max` nor an enum has none. It holds a choice spec's values to a string domain's `pattern`, but not a
text spec. Past those limits, keeping a spec within the registry is the product's.

```swift
public protocol ValueSpec: Sendable { var path: String { get }; var json: JSON { get } }
public enum TextUnit: String, Sendable { case chars, bytes }
public struct TextSpec: ValueSpec {
  public init(_ path: String, unit: TextUnit, min: Int, max: Int, trim: Bool, nfc: Bool)
  public func apply(_ s: String, at: Path) throws(Violation) -> String
  public func apply(_ s: String?, at: Path) throws(Violation) -> String?   // nil passes
  public func measure(_ s: String) -> Int                                   // §4.3 steps 1, 2 and 4
  public static func isBlank(_ s: String) -> Bool                           // only §4.3's whitespace
}
public struct NumberSpec: ValueSpec {
  public init(_ path: String, min: Double, max: Double, integer: Bool = false, quantum: Double? = nil)
  public func apply(_ x: Double, at: Path) throws(Violation) -> Double
  public func apply(_ x: Double?, at: Path) throws(Violation) -> Double?
  public func apply(_ x: Int, at: Path) throws(Violation) -> Int
  public func apply(_ x: Int?, at: Path) throws(Violation) -> Int?
}
public struct ChoiceSpec: ValueSpec {
  public init(_ path: String, values: [String])
  public func apply(_ s: String, at: Path) throws(Violation) -> String
  public func apply(_ s: String?, at: Path) throws(Violation) -> String?
}
public struct CountSpec: ValueSpec {
  public init(_ path: String, min: Int, max: Int)
  public func apply<V: ValueObject>(_ items: [V], at: Path) throws(Violation) -> [V]
  public func apply<V: ValueObject>(_ items: [V]?, at: Path) throws(Violation) -> [V]?
}
```

### §4.3 The pipelines

Each `apply` is an ordered, fail-fast pipeline; the first failing step throws.

**Text.**
1. `nfc` → Unicode Normalization Form C, by `DomainKitNFC.nfc` (Swift: Foundation's
   `precomposedStringWithCanonicalMapping`; Kotlin: `java.text.Normalizer`, form NFC).
2. `trim` → remove leading and trailing whitespace. Whitespace is exactly U+0009–U+000D, U+0020,
   U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF: ECMAScript `\s`,
   the set the engine's text merge tokenises on (engine §6.11). No platform predicate is used.
3. A U+0000 anywhere → `nul`: the engine refuses it in every string (engine §6.1 step 2).
4. Measure with `MeasureUnit.chars.length(of:)` (Unicode scalars) or `MeasureUnit.bytes.length(of:)`
   (UTF-8 bytes) (ER-11). Never `String.count` or Kotlin `String.length`.
5. Measured 0 and `min ≥ 1` → `blank`.
6. Measured below `min` → `tooShort`.
7. Measured above `max` → `tooLong`, carrying the measured count.
8. Return the normalised text.

**Number.**
1. Not finite → `notANumber`.
2. `integer` and not integral → `notInteger`.
3. `quantum q` → `Quantum(q).rounded(x)` (ER-11), engine §7.1 step 4's rounding; `-0` becomes `0`.
4. Below `min` → `below`; above `max` → `above`, on the rounded value.
5. Return the rounded value.

A spec with both `integer` and `quantum`, or with a quantum that is neither an integer nor `1/k`, traps
at construction.

**Choice.** Not one of `values`, compared by UTF-8 bytes → `notOneOf`.

**Count.**
1. Fewer than `min` items → `tooFew`; more than `max` → `tooMany`.
2. Validate each item in order with `item.validated(at: path + index)`; the first violation throws.
3. Return the validated items.

Written values are compared by JCS (engine §3.2), never by Swift `String ==`, which equates
canonically equivalent strings.

### §4.4 Violations

```swift
public struct Path: Hashable, Sendable, ExpressibleByStringLiteral {
  public init(stringLiteral: String)
  public static func + (p: Path, k: String) -> Path
  public static func + (p: Path, i: Int) -> Path
}
public struct Violation: Error, Hashable, Sendable {
  public let rule: String
  public let path: Path
  public let reason: Reason
  public enum Reason: Hashable, Sendable {
    case blank, nul, notANumber, notInteger, notOneOf
    case tooShort(min: Int, unit: TextUnit), tooLong(max: Int, unit: TextUnit, measured: Int)
    case below(min: Double), above(max: Double)
    case tooFew(min: Int), tooMany(max: Int)
    case custom(String)
  }
  public init(rule: String, path: Path, reason: Reason)
}
```

`custom` carries a product reason for a LOCAL rule written as code, such as "today or earlier". The
UI maps `(rule, reason)` to copy.

### §4.5 Checks and `Valid`

```swift
public struct Moment: Sendable {
  public let now: Instant
  public let zone: any Zone
  public var today: LocalDay { get }
  public init(now: Instant, zone: any Zone)
}
public struct Check<E>: Sendable {
  public let field: String?                                                   // nil: a check on the key
  public init(_ field: String, _ apply: @escaping @Sendable (inout E, Moment) throws -> Void)
  public static func key(_ apply: @escaping @Sendable (E, Moment) throws -> Void) -> Check
}
public struct Valid<E: Writable>: Sendable {
  public let value: E
  public let checked: [String]                                                // UTF-8 order
  public init(_ value: E, at moment: Moment) throws(Violation)                // every field
  public init(_ value: E, fields: [String], at moment: Moment) throws(Violation)
}
```

- `Valid` runs, in `E.checks` order, every key check and the check of every named field, each field
  check normalising its field in a copy of the value; the first violation throws. A field with no
  check passes as it is.
- A check throws only `Violation`, from the specs it applies; `Valid` traps on any other error. Its
  closure is so written without a thrown-type annotation, which Swift does not infer for a closure
  literal.
- A field check reads and writes its own field. It reads another field only when every write path
  writes both together (D-13); a `SaveDraft` update writes each touched field on its own. It MAY read
  the record's id, which never changes.
- A **key check** constrains the natural key, such as a weigh-in's day: "today or earlier". It reads
  only the id and the moment, and runs on every write of the record.
- A `Timestamped` entity's field, when named, takes the moment's `now` after the checks, whatever
  it held. Inside a run the moment is the one the load read, whose `now` is the commit's (§5.3).
- `Valid` has no other initialiser, so no plan writes a value that skipped its checks (INV-5).
- A save validates exactly the fields it writes (§10.2). A stored value that another writer admitted
  within the registry, and that today's checks would refuse, never blocks an edit of another field,
  except in a record that is one fact, whose every save writes and so validates every field.

---

## §5 Time

### §5.1 Types

```swift
public struct Instant: Hashable, Comparable, Sendable { public let ms: Int64; public init(ms: Int64) }
public struct LocalDay: Hashable, Comparable, Sendable {
  public let year: Int, month: Int, day: Int
  public init?(_ text: String)                               // "YYYY-MM-DD", a real day, years 0001–9999
  public init(_ instant: Instant, offsetSeconds: Int)
  public init(_ instant: Instant, in zone: any Zone)
  public var text: String { get }
  public func adding(days: Int) -> LocalDay
  public func days(until other: LocalDay) -> Int
  public var weekday: Int { get }                            // ISO: Monday 1 … Sunday 7
}
public protocol Zone: Sendable { func offsetSeconds(at instant: Instant) -> Int }
public struct FixedZone: Zone { public init(offsetSeconds: Int); public func offsetSeconds(at instant: Instant) -> Int }
```

Kotlin declares the same types as the kit's own, not `java.time`'s.

### §5.2 Algorithms

All arithmetic is on 64-bit integers; `/` is floor division and `mod` is floor modulo.

```
LocalDay(instant, offsetSeconds) := civil((instant.ms + offsetSeconds × 1000) / 86 400 000)

civil(days):                                                     // proleptic Gregorian, days since 1970-01-01
  z := days + 719 468;  era := z / 146 097;  doe := z − era × 146 097
  yoe := (doe − doe/1460 + doe/36 524 − doe/146 096) / 365
  doy := doe − (365 × yoe + yoe/4 − yoe/100);  mp := (5 × doy + 2) / 153
  day := doy − (153 × mp + 2)/5 + 1;  month := mp < 10 ? mp + 3 : mp − 9
  year := yoe + era × 400 + (month ≤ 2 ? 1 : 0)

daysSinceEpoch(y, m, d): the inverse of civil
adding(days: n) := civil(daysSinceEpoch + n);  days(until: o) := o.daysSinceEpoch − daysSinceEpoch
weekday := (daysSinceEpoch + 3) mod 7 + 1
parse: exactly `DDDD-DD-DD`; 1 ≤ year ≤ 9999; 1 ≤ month ≤ 12; 1 ≤ day ≤ the month's length, February having 29 days
       iff year mod 4 = 0 ∧ (year mod 100 ≠ 0 ∨ year mod 400 = 0); otherwise nil
text: year, month and day zero-padded to 4, 2 and 2 digits
```

### §5.3 Rules

- Domain time comes only from a moment: inside an action the reader's, whose `now` is the commit's
  `CommitContext.now`, the one `physNow()` read that also fills its unset `time` fields (engine §7.1
  step 4); outside actions `ActionRunner.moment()`, over `Replica.physNow()` (ER-8).
- The zone is the app's port; production answers the device's zone at the instant asked. Tests use
  `FixedZone`.
- A `time` field is left to the engine unless the value is a device-observed instant other than
  `now`. A minted create leaves a nil `time` field unset, and the engine fills it with the commit's
  `now` (engine §7.1 step 4). An `instant` command argument is a person's choice; a rule comparing it
  with `now` is LOCAL.
- A field that records each save's own moment is an `lww` field, not a `time` one, which keeps its
  first value: a `Timestamped` entity names it, and `Valid` gives it the moment's `now` (§4.5).
- A keyed type whose key is a local date takes `LocalDay.text` as its id (`ID(day)`).

---

## §6 Rules: LOCAL and SERVER-DECIDED

### §6.1 Where each kind is enforced

| | LOCAL | SERVER-DECIDED |
|---|---|---|
| Verdict depends on | one register's value, or fields always written together, and the moment | state others can change concurrently |
| Declared as | a value spec (data), or a named check | a rule-book entry: name, codes, subject type |
| Evaluated | by `Valid`, on the fields a write names | predicted in decide or at commit over `stored`; decided by the server at admission |
| A failure | `Violation`: nothing is written | predicted: `Refused` on path `predicted`, nothing written; decided: a notice, path `notice` |
| Server backstop | registry bounds (engine §6.1 step 2) and product checks | the rule itself |

LOCAL value specs stay within the registry bounds the server enforces (§4.2); `RegistryCheck`
tests it. The server does not apply the kit's specs.

### §6.2 Who predicts a SERVER-DECIDED rule

Exactly one of:
1. **The engine at commit.** `cap` (engine §7.1 step 8, held deletes occupying their slots, detail
   `{type, cap}`), `scope-dead` (step 2) and `too-large` (step 8). The runner maps the engine's local
   refusal (§9.2 step 7). A local `too-large` reaches the product once, as that refusal: the runner
   dismisses the notice the engine wrote to hold the gesture.
2. **The kit.** `stale`: a guarded save whose changed fields hold, in `stored`, other values than the
   draft's base (§10.2).
3. **The product.** A pure function over the loaded `stored` view, in decide. Example: a phone logs
   into the open, non-stale session its `stored` view holds, and calls `gym.start` only when none is
   open. The server still decides (`gym.start` joins).

`cap` stays the engine's. An action that must hear of it in decide, as a Coach executor records a
refusal in its own gesture (§9.3), applies the engine's own count there first: the growth rule
(§7.3). A rule no client can predict, such as a session overlap, is declared all the same, so its
refusal maps (§12).

**The gone precondition** (§9.2 step 5) is not a prediction. A product maps its `unknown-record`, with
the server's `unknown-record` and `record-dead`, to one "gone" refusal.

### §6.3 The rule book

```swift
public struct Rule: Hashable, Sendable {
  public enum Kind: Hashable, Sendable { case local, serverDecided }
  public let name: String, subject: String, kind: Kind
  public let codes: [RefusalCode]                         // SERVER-DECIDED, or a LOCAL backstop
  public let spec: JSON?                                                      // a LOCAL spec's JSON form
  public static func local(_ spec: some ValueSpec) -> Rule                   // name: spec.path
  public static func local(_ name: String, subject: String, backstop: [RefusalCode] = []) -> Rule
  public static func serverDecided(_ name: String, codes: [RefusalCode], subject: String) -> Rule
}
public struct RuleBook: Sendable {
  public init(registry: Registry, entities: [any Entity.Type], rules: [Rule])
  public let rules: [Rule]                                                   // UTF-8 order of name
  public var json: JSON { get }
}
```

- Each product declares one rule book, gathering every feature's rules and entities.
- The book adds each entity's standard rules: `<type>.gone` (`unknown-record`, `record-dead`) for a
  type with life; `<type>.taken` (`id-taken`, `id-spent`) for a minted type; `<type>.stale` (`stale`)
  for a guarded `Draftable`; `<type>.cap` (`cap`) for a type with a registry cap; `<type>.size`
  (`too-large`) for a type with a `text` field (engine §6.11 step 3). A product declares only its own.
- Its JSON holds the rules and, per entity, `{type, removable, held, ordered, guarded, timestamp?}`,
  `timestamp` naming a `Timestamped` entity's field. It is checked in as
  `packages/api-contract/<product>/domain/rules.json`. Each implementation's tests encode its book
  and compare it with that file by JCS (`RuleBookParity`), so a spec, a hold, a guard or a
  timestamp declared in Swift and Kotlin cannot drift.
- A LOCAL rule written as code MAY declare the code its server half refuses with: a weigh-in's
  "today or earlier" is a key check here, and `bad-instant` from the server (engine A.2).
- `RuleBookCheck` fails unless names are unique, every LOCAL rule has a vector, every code of every
  SERVER-DECIDED rule maps to a non-generic product refusal on both paths, and every backstop code on
  the `notice` path. It maps each code as `Refused(code, subject:, detail:, path:)` with a subject of
  the rule's subject type and, for `cap`, the detail `{type, cap}` of that type's registry cap.

---

## §7 Reading

### §7.1 The reader

```swift
public struct Reader {                                  // valid only inside one run or read
  public let moment: Moment
  public func repository<E: Entity>(_ type: E.Type) -> Repository<E>
  public func device(_ key: String) throws -> JSON?    // device/<product> rows (engine §2.5)
  public func firstPullComplete() throws -> Bool       // engine §7.9, for the reader's scope
}
```

A `Reader` exists only inside `ActionRunner.run` and `ActionRunner.read`, over the engine's
`CommitContext` or `ScopeReader`. Inside `run` it holds the store's writer (Swift engine §5.2), so
`load` reads only what the decision needs; a derived read over a whole history runs in
`ActionRunner.read`, outside any commit.

### §7.2 Repositories

```swift
public struct Repository<E: Entity> {
  public func find(_ id: ID<E>, in view: ViewMode) throws -> E?
  public func all(in view: ViewMode) throws -> [E]
  public func children<P: Entity>(of parent: ID<P>, via field: String, in view: ViewMode) throws -> [E]
  public func capacity() throws -> Capacity
  public static func decode(_ records: some Sequence<Record>) throws(DecodeError) -> [E]
}
extension Repository where E: Ordered {
  public func anchor(_ placement: Placement) throws -> RecordID?
}
```

- The view is always explicit. **`stored` decides; `drawn` draws** (INV-9): capacity, stale checks
  and write positions read `stored`; what the person sees or acts on, including the relations a
  write depends on, reads `drawn`.
- `find`, `all` and `children` return visible records only (engine §7.6 `visible`).
- `all` and `children` order an `Ordered` type by its key, then its id, both by UTF-8 bytes (engine
  D-25), and any other type by id bytes. `decode` gives the UI the same decoding and order over a
  `RecordsView`.
- `children` reads through the engine's indexed read (ER-12), so its cost follows the children, not
  the type.
- A record that fails to decode throws `DecodeError`: a schema fault, surfaced, never skipped.
- A product declares an aggregate's repository as a function composing these.

### §7.3 Capacity

```swift
public struct Capacity: Equatable, Sendable {
  public let type: String, used: Int, cap: Int
  public var isFull: Bool { get }                                              // used ≥ cap
  public func refusal(growing growth: Int, subject: RecordRef?) -> Refused?   // the growth rule
  public init<E: Entity>(of: E.Type, stored: some Collection<Record>, registry: Registry)
}
```

`used` counts the visible `stored` records of the type, so a record inside its delete window still
occupies its slot (engine §7.6 `capCount`). The UI computes it from a `stored` `RecordsView`, so the
"full" line, `isFull`, and the engine's commit-time check read the same count.

**The growth rule** is the engine's (engine §6.1 step 12), which that check applies to `stored`. A
plan's `growth` is its creates of the type less its removals of it. `refusal(growing:subject:)` returns
`Refused(cap, subject:, detail: {type, cap}, path: .predicted)` when `growth > 0` and `used + growth >
cap`, `subject` being the first record the plan creates of the type (§12.1), and nil otherwise. A plan
that removes one record and creates another at the cap grows by 0 and is admitted.

### §7.4 Derived reads

- A derived read is a pure function over decoded entities, taking a moment when it depends on time.
  It never reads the engine, mints, writes or reads a clock.
- The same function serves the UI over `RecordsView` snapshots, actions inside decide, a Coach
  executor, and a product binding's `liveHint` (engine §7.4).
- A read that asserts absence, a record or a best ("no weigh-ins yet", a PR, the seeds offered to an
  empty account) takes `firstPullComplete` as an input and asserts nothing until it is true.
- A read over children drops those whose parent is not visible in the same view, so a held removal
  of a parent hides its children before the server's consequences arrive.
- A read a shared corpus pins (gym Coach §3.3) returns a total order, ties broken by id bytes, and
  rounds last. Its vectors live at `packages/api-contract/<product>/rules/<read>.json`.

### §7.5 Order and placement

```swift
public enum Placement: Hashable, Sendable { case top, below(RecordID), bottom }
```

- An `Ordered` type's key is written only by an anchored create and by a move, each writing the key
  of one record. The engine computes it from the anchor (engine D-25 and engine §7.1 step 4).
- `anchor` resolves a placement in the load phase: `top` → none; `below(x)` → `x`; `bottom` → the last
  member in `stored` order, or none when `stored` holds none. A member inside its delete window can so
  anchor (engine D-25), and a new member placed at the bottom stays below it if the delete is undone.

---

## §8 Plans

### §8.1 The vocabulary

```swift
public struct Plan: Sendable {
  public init()
  public init<C: ServerCommand>(running command: C, predicting: [Prediction] = []) throws(Violation)
  public mutating func create<E: Writable>(_ value: Valid<E>)
  public mutating func create<E: Writable>(_ value: Valid<E>, fields: [String])       // keyed, singleton
  public mutating func insert<E: Writable & Ordered>(_ value: Valid<E>, below anchor: RecordID?)
  public mutating func update<E: Writable>(_ value: Valid<E>, fields: [String]? = nil,
                                           from base: E? = nil, guarded: Bool = false)
  public mutating func remove<E: Removable>(_ id: ID<E>)
  public mutating func move<E: Ordered>(_ id: ID<E>, below anchor: ID<E>?)
  public mutating func guardRead<E: Entity>(_ id: ID<E>, fields: [String])
  public mutating func device(_ key: String, _ value: JSON?)
}
```

- `create` writes every field of `value.fields`, or the named ones; `insert` writes every field and
  places the record below the anchor.
- `update` names fields, by default `value.checked`, which pairs with `Valid(_:fields:at:)`: a value
  validated for every field names every field. The engine writes each named field whose value
  differs from `drawn` (engine §7.1 step 4).
- `guarded` guards every lattice field the update names; `guardRead` guards registers the decision
  read without writing, as a device-minted Coach proposal guards its routine's `name` and `entries`
  (engine A.2). Text fields are never guarded (engine §7.1 step 6).
- A plan is **held** iff it removes a type whose `heldRemoval` is true. Holds cover removals only; a
  held plan MAY also write device rows, which the engine writes at commit and never holds (engine §7.1
  step 10).
- An action builds a plan from the value it loaded and names only the fields its caller set, never
  every field, so a value another writer stored is never rewritten by normalisation.

### §8.2 Translation to one gesture

`translate(plan, registry) → Gesture` is pure. Operations map by identity class (engine §4.1):

| Plan operation | `minted` | `keyed` with life | `keyed` without life | `singleton` |
|---|---|---|---|---|
| `create`, `insert` | `.create(t, id: .given(id), f, anchor:)` | `.put(t, id, present: true, f)`, and `retire` names the record | `.write(t, id, f)` | `.write(t, singletonId, f)` |
| `update` | `.update(t, id, f)` | `.put(t, id, present: nil, f)` | `.write(t, id, f)` | `.write(t, singletonId, f)` |
| `remove` | `.delete(t, id)` | `.put(t, id, present: false)` | — | — |
| `move` | `.move(t, id, to: OrderAnchor(field: orderField, below:))` | same | same | — |

- `f` holds the named fields' values, less a nil `time` field of a minted create (§5.3). A text field,
  by the registry's field kinds, goes in `texts` as a `TextEdit`, edited from its value in the
  operation's base: an update's `base`, or the draft's base in a present-again save's create (§10.2
  step 5). A create with no base edits from `""`.
- A keyed create inside that record's own delete window retires the held removal in the same
  transaction (engine §7.1 step 4). The record never died, so it keeps its untouched fields, and the
  put adds the written ones.
- A `wholePut` type's create and update name every client-written field (§8.3 rule 9); the engine
  writes such a put whole, every field and a fresh life at one stamp (engine §7.1 step 4).

| Gesture option | Value |
|---|---|
| `changes` | the operations, in the order the plan made them |
| `atomic` | true iff the plan's ordinary operations write more than one record; a command already groups its deltas into one atomic intent (engine §7.1 step 7) |
| `hold` | true iff the plan is held |
| `guards` | every lattice field a guarded update names, and every `guardRead` register |
| `retire` | every keyed-with-life record the plan creates |
| `command`, `predict` | the plan's command and predictions (§8.4) |
| `local` | the plan's device writes, in order |
| `gestureId` | nil (the engine mints it) |

**Order.** Every collection the kit produces from a map or set is ordered by the UTF-8 bytes of its
key: a draft's touched fields, the fields a save names, `guards` (type, id, field), `retire`, and the
rule book. Swift seeds `Set` and `Dictionary` iteration order per process, so no hashed collection's
order reaches an output; the vectors compare order exactly.

**An emptied gesture.** When every named field equals `drawn`, the gesture has no delta and no
command, so it forms no intent and its guards go with none (engine §7.1 step 7; the corpus case
`commit/deltas.json` "an update that changes nothing"). Its receipt lists no local id, and the runner
reports `unchanged` (§9.2 step 7).

### §8.3 Plan rules

Translation throws `PlanError`, a programming fault that fails the run and any test reaching it,
when:
1. an operation's type lives in a scope other than the action's;
2. two operations name one record;
3. a held plan contains any operation other than removals of held types and device writes, or runs a
   command;
4. `create` names an `Ordered` type (use `insert`), or `create(_:fields:)` a minted type;
5. a prediction's type is not in the command's registry `predicts`;
6. a named field is not client-written, is `serial` or the order field, is absent from
   `value.fields`, or is not among `value.checked`;
7. an update names a `const` or `time` field (engine §4.4), or a text field without a `base`;
8. an update names no field, or a keyed create writes no field;
9. a create or update of a `wholePut` type leaves out one of its client-written fields (engine §2.4).

So a held plan carries removals only, and `drawn` and `stored` differ only in records a held removal
names (INV-9).

### §8.4 Server commands and predictions

```swift
public protocol ServerCommand: Sendable {
  static var name: String { get }             // the registry command, from SyncSchema
  static var specs: [any ValueSpec] { get }   // its string arguments' specs, at <name>.<argument>
  var args: [String: JSON] { get }            // ref<t>: an id; time and instant: Instant.ms
}
public struct Prediction: Sendable {
  public static func create<E: Entity>(_ type: E.Type, _ id: ID<E>, _ values: [String: JSON]) -> Prediction
  public static func update<E: Entity>(_ type: E.Type, _ id: ID<E>, _ values: [String: JSON]) -> Prediction
  public static func remove<E: Entity>(_ type: E.Type, _ id: ID<E>) -> Prediction
}
```

- A plan runs a command only when built by `Plan(running:)`, so at most one. It applies each spec in
  `specs` to the strings at its path, nested ones included, and sends them normalised; a `Violation`
  throws, which decide refuses. `RegistryCheck.command` requires, for every `string` argument path,
  a `TextSpec` or `ChoiceSpec` in `specs` and in the book (§3.4 step 10).
- Predictions are the values the product expects the command to write, server-written fields
  included, unvalidated. The engine draws them until the command's entry resolves, once the cursor
  covers its result (engine §7.5 step 2), and restamps or rewrites them through the write map (engine
  §7.7).
- A removal prediction draws a dead life register, preserving the record's born. It becomes a
  keyed `put(present: false)` or a minted `delete`; a refused command restores the prior record.
- A product holds no predicted id across the result; it reads the record again from a view.
- A command's refusal codes are declared in the rule book.

---

## §9 Actions

### §9.1 The interface

```swift
public protocol Decider: Sendable {
  associatedtype Loaded
  associatedtype Result
  associatedtype Refusal: ProductRefusal
  var scope: ScopeRef { get }
  func load(_ read: Reader) throws -> Loaded
  func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Result, Refusal>
}
extension Decider {
  public func decision(_ loaded: Loaded, ids: IDSource) -> Decision<Result, Refusal>   // decide, one refusal channel
}
public protocol Action: Decider where Result: Sendable {}
public enum Decision<Result, Refusal> { case write(Plan, Result), unchanged(Result), refuse(Refusal) }
extension Decision where Result == Void { public static func write(_ plan: Plan) -> Decision }
public enum Outcome<Result, Refusal> { case committed(Result, CommitReceipt), unchanged(Result), refused(Refusal) }
extension Outcome {
  public var receipt: CommitReceipt? { get }
  public var refusal: Refusal? { get }
}
extension Outcome: Sendable where Result: Sendable, Refusal: Sendable {}
public struct IDSource { public func mint<E: Entity>(_ type: E.Type) -> ID<E> }   // valid only inside one run
```

- **Load** reads through the reader and nothing else. When the domain needs more data than the first
  reads give, load calls a pure domain function to decide what to read next, then reads it.
- **Decide** is pure: its inputs are the loaded value and the id source. It validates with `Valid`,
  over the moment its load read from the reader, predicts SERVER-DECIDED rules, and builds at most
  one plan.
- **Decision** is decide with one refusal channel: a `Violation` decide throws becomes
  `refuse(Refusal(violation))`. The runner (§9.2 step 4) and every composer (§9.3) read `decision`,
  never `decide`, so every refusal arrives as `refuse`.
- A decider is a value; its stored properties are its input. A domain holds no mutable state outside
  values.
- An action's `Result` and its receipt are the only domain events the kit produces: the Undo transient
  takes `receipt.gestureId` and `releaseAt`, and a Coach executor records a call from the result.

### §9.2 The pipeline

```swift
public final class ActionRunner: Sendable {
  public init(replica: any Replica, registry: Registry, zone: any Zone)
  public func run<A: Action>(_ action: A) throws -> Outcome<A.Result, A.Refusal>
  public func read<T>(_ scope: ScopeRef, _ body: (Reader) throws -> T) throws -> T
  public func undo(_ gestureId: String) throws -> Bool
  public func mint<E: Entity>(_ type: E.Type) -> ID<E>
  public func moment() throws -> Moment
}
```

`run(action)` is one ordered, fail-fast pipeline:

1. **No nesting.** A run entered in an execution context already inside a run traps (Swift
   `preconditionFailure` over a `@TaskLocal` flag; Kotlin `check` over a coroutine-context
   element in the runner, never a `ThreadLocal`). A nested run
   reached through a port that hops threads and waits deadlocks on the store's writer instead.
2. `replica.commit(action.scope) { ctx in … }`: one local transaction (engine §7.1, read-and-commit
   form). Steps 3–6 run in it. A `CommitFailure` of kind `malformed` traps (ER-14); `run` rethrows
   any other error `commit` throws.
3. **Load** with `Reader(ctx, zone)`. A store or decode error rethrows; nothing is written.
4. **Decide** by `decision` (§9.1). `refuse` and `unchanged` return no gesture: the engine writes
   nothing and ticks no clock (engine §7.1).
5. **Gone.** For every update, remove or move of a type with life, `ctx.drawn(t, id)` must hold the
   record alive, and every insert or move that names an anchor needs that anchor visible, with its
   order key, in `drawn` or in `stored` (engine D-25). Otherwise the body returns no gesture and the
   outcome is `refused(R(Refused(unknown-record, subject, path: .predicted)))`, whose subject is the
   first gone record or absent anchor in the plan's order. The engine throws on either write (engine
   §7.1 step 4); the runner refuses it for every action.
6. **Translate** (§8.2), which may throw `PlanError`; return the gesture.
7. **Map.** `committed(receipt)` with no local id, no retired gesture and no device write →
   `unchanged(result)`; otherwise `committed(result, receipt)`. `refused(code, detail, notice)` →
   `refused(R(Refused(code, subject, detail, path: .predicted)))`, with §12.1's subject. A `notice`
   is the one a `too-large` commit wrote to hold its gesture (engine §7.1 step 8). The runner
   dismisses it first (`Replica.dismissNotice`, engine D-17), so the product hears of the refusal
   once, from this outcome, and a draft saved again at every pause piles up no notices. A dismissal
   that throws rethrows from `run`.

`read` builds a reader over `Replica.read`. `undo` is `Replica.undo`: true iff every entry of the
gesture was still held (engine §7.3). `mint` is `Replica.mintID`. `moment` is `Replica.physNow()`
with the runner's zone.

`run` is synchronous and not cancellable (engine §7.1). The UI calls it from a non-cancellable
context: on iOS any thread; on Android `withContext(NonCancellable)` on the caller's thread.

### §9.3 Composition

An action MAY run another decider's `load` and `decision` inside its own, another action's or a
`SaveDraft`'s, and extend its plan: decisions and plans are values, and the standard deciders are
public. A composer reads `decision`, whose `refuse` holds every refusal, a thrown violation included
(§9.1). A Coach executor so records an ability call on the Coach message in the same gesture as the
ability's writes (gym Coach §4.3 step 2): on `write` it adds the unguarded message update to the inner
plan, on `refuse` it writes that update alone. A plan the engine refuses at commit records nothing, so
an executor that can hear of such a refusal in decide does: `cap` by the growth rule (§7.3), as
`save_note` does at the 10-note cap. It saves a note of its own with `SaveDraft(creating:)` and
returns a result of its own, never `Saved` (§10.1).

---

## §10 Drafts

### §10.1 The draft and its save

```swift
public struct Draft<E: Draftable> {                        // a value; not Sendable
  public let id: ID<E>
  public private(set) var base: E                          // opened or blank; then the last save's
  public var current: E
  public private(set) var isNew: Bool
  public let placement: Placement?                         // a new draft of an Ordered type
  public init(new blank: E)
  public init(opening value: E)
  public var touched: [String] { get }                     // UTF-8 order
  public var isDirty: Bool { get }
  public func rebased(onto theirs: E) -> Draft
}
extension Draft where E: Ordered { public init(new blank: E, placed: Placement) }
public enum SaveResult<R: ProductRefusal>: Sendable {
  case saved(CommitReceipt?)                               // nil: nothing needed writing
  case refused(R)
  case failed(any Error)                                   // a store failure: nothing was written
}
public struct Saved: Equatable {                           // made only by SaveDraft; not Sendable
  public let values: [String: JSON]                        // the fields the draft takes, as stored
  public let exists: Bool                                  // the record is in `stored` after the save
}
extension ActionRunner {
  public func open<E: Draftable>(_ id: ID<E>) throws -> Draft<E>?                  // nil: not in drawn
  public func open<E: Draftable>(_ id: ID<E>, orNew blank: E) throws -> Draft<E>  // keyed or singleton
  public func save<E: Draftable, R: ProductRefusal>(_ draft: inout Draft<E>, _ type: SaveDraft<E, R>.Type)
    -> SaveResult<R>
}
```

- A field is **touched** when its value in `current` differs from its value in `base`, by JCS of
  `fields`. `isDirty` is true iff a field is touched.
- `init(new:)` takes a **blank** as its base: the entity with its id and nothing a person set. A
  prefill is an edit of `current` after it, and so is touched. A minted draft's id is minted when it
  opens (`ActionRunner.mint`); a keyed draft takes its natural key.
- `init(opening:)` takes the entity as read, from `find(id, in: .drawn)`, as base and current.
  `open(id)` is that read, or nil when the record is not in `drawn`. `open(id, orNew:)` opens the
  record, or starts a new draft of the blank. It traps on a minted type, whose absent record is gone,
  and on a blank whose id is not `id`.
- A text field's edit starts from its value in `base`: `""` in a blank, the text as read, then the
  text the last save stored. The save names the base, and translation finds the text fields in the
  registry (§8.2), so an entity declares nothing for them.
- A draft holds raw values: an editor may hold a blank name or 21 sets. The UI MAY run `Valid` live
  on the touched fields to show the first violation.
- The kit applies field values to a draft by decoding a record built from `fields` (§3.4 step 7).

**Saving** (INV-14). `runner.save(&draft, SaveNote.self)` builds the draft's save and runs it as one
commit (§9.2). Only `save` builds a `SaveDraft` from a `Draft`, and no action returns a `Saved`, so
`save` is a draft's only door; an executor saves a record of its own with `SaveDraft(creating:)`
(§11). It is synchronous and never throws:
- `.saved`: `base` and `current` take `Saved.values`, each as the store holds it (a quantum field
  rounded, §3.4 step 9), and `isNew` ends if the record `exists`. The receipt is nil when nothing
  needed writing.
- `.refused` and `.failed`: the draft is as it was; a new draft stays new, and an edited one stays
  dirty. The UI says the input is not saved, and the next save retries it.
- `.failed` is a store failure, or a replica that cannot write. No gesture was written: `commit`
  throws only before its transaction commits (engine §7.1), and the runner's dismissal only after a
  refusal (§9.2 step 7), so saving again is safe.
- A programming fault traps instead: a `current` whose id is not the draft's, a `PlanError`, a
  `DecodeError`, and a `CommitFailure` of kind `malformed` (ER-14).
- A caller reads the result with a `switch`; a `default` case can drop "not saved".

**One draft, saved in place.** An editor saves the draft it holds, in place: never a copy, and never
a second open draft of the same record. Either leaves the held draft on its old base, and that
draft's next save edits from it: its text can merge against the person's own words, and a guarded
field refuses `stale` against this device's write.
- Swift: `Draft` is not `Sendable`, and every non-test target of `WindmillKit` and the app is
  main-actor code by default, in language mode 6 with warnings as errors (§2.4 item 3). So the held
  draft is saved only on the main actor: a task, queue or thread that captures it does not compile,
  and a Dispatch block the SDK leaves unannotated traps when it runs off the main thread. A copy
  rebuilt elsewhere from the draft's entities is the copy case. `nonisolated`, `@unchecked Sendable`
  and `nonisolated(unsafe)` opt out deliberately, and are out of scope.
- Kotlin: `Draft` is immutable, and each edit returns a new draft, which Compose state or a
  `StateFlow` holds. `save` hands the draft after the save to a write-back the caller must pass, so it
  cannot be dropped by omission, and returns the result:

  ```kotlin
  class Draft<E : Writable<E>> {                            // immutable; carries its opening thread
      val id: Id<E>; val base: E; val current: E; val isNew: Boolean; val placement: Placement?
      val touched: List<String>; val isDirty: Boolean
      fun edit(change: (E) -> E): Draft<E>
      fun rebased(onto: E): Draft<E>
      companion object {
          fun <E : Writable<E>> new(blank: E, placed: Placement? = null): Draft<E>  // placed: Ordered only
          fun <E : Writable<E>> opening(value: E): Draft<E>
      }
  }
  sealed interface Placement                                 // Top, Below(id: RecordId), Bottom
  sealed interface SaveResult<out R>      // Saved(receipt: CommitReceipt?), Refused(refusal), Failed(error)
  interface Refusals<R> { fun of(v: Violation): R; fun of(r: Refused): R; fun isGeneric(f: R): Boolean }
  fun <E : Writable<E>> ActionRunner.open(type: DraftType<E>, id: Id<E>): Draft<E>?
  fun <E : Writable<E>> ActionRunner.open(type: DraftType<E>, id: Id<E>, orNew: E): Draft<E>
  fun <E : Writable<E>, R> ActionRunner.save(draft: Draft<E>, type: DraftType<E>, refusals: Refusals<R>,
                                             writeBack: (Draft<E>) -> Unit): SaveResult<R>
  ```

  `runner.save(draft, Routine, GymRefusals) { draft = it }` is an editor's save. The write-back runs
  once, before `save` returns, with the draft after the save, whatever the result. `save` traps on a
  thread other than the one the draft was opened on, which the draft carries, and `edit` traps on a
  change that returns another id. `mint`, `run`, `undo` and `moment` follow §9.2.
- An Android editor opens, edits and saves its draft on the main thread, so its commit runs there: one
  local commit that never awaits the network (engine §7.1). The Swift engine budgets 8 ms p95 (Swift
  engine §4.6); the Kotlin engine's budget is owed (ER-10).
- A record with a text field has one open draft per device, and no other local writer of its text:
  two unsent writes from one base merge against each other on the server (engine §6.11).
- A `Timestamped` entity's field belongs to the save: each save of it writes the commit's `now`
  there (§4.5), whatever `current` holds, and the draft takes that value with the others.
- A field saved while the person may still be typing in it declares no `trim`, since a save writes
  the stored value into `current`.

### §10.2 Save: `SaveDraft<E, R>`

**Load:** `drawn := find(id, in: .drawn)`, `stored := find(id, in: .stored)`, `folded :=` the record
of `id` in `stored`, visible or not (ER-3), the reader's moment, and for a new draft of an `Ordered`
type, `anchor := anchor(placement ?? .bottom)`.

**Decide**, in order. A `Saved` names the fields the draft takes, a written field at its validated
value, and `exists`, whether the record is in `stored` after the save:
1. **Whole.** A `wholePut` type (engine §2.4), whatever is touched: validate every field (a
   `Timestamped` entity's at the moment's `now`, §4.5) and write `create(valid)`: every client-written
   field and a fresh life, which retires this device's held removal of the record (§8.2). It is
   never unchanged, gone or stale: each save is the newest fact, and the newest save wins whole
   (engine §7.1 step 4). Saved: every field; `exists` is true.
2. **Unchanged.** No field touched, and the draft is not a new draft of a minted type → `unchanged`,
   with no field; `exists` iff `stored ≠ nil`. A new keyed draft with nothing touched so writes
   nothing.
3. **Gone** → refuse `Refused(unknown-record, subject, path: .predicted)`, when `drawn = nil` and:
   - the type is minted, and the draft is not new or its record is in `stored`; or
   - the type is keyed with life, the draft is not new, and `stored = nil`: another device deleted
     the record this draft opened.
4. **Create.** A minted type with `stored = nil`: validate every field and write `create(valid)`,
   or `insert(valid, below: anchor)` for an `Ordered` type. A blank refuses on its checks, and a
   prefill is created. Saved: every field, a nil `time` field at the moment's `now`, which the engine
   writes (§5.3).
5. **Present again.** A keyed or singleton type with `drawn = nil`: a new draft, or a record inside
   this device's own delete window (`stored ≠ nil`), or a keyed record without life that holds no
   visible value. Validate every field of a new draft, and the touched fields otherwise, then write
   `create(valid, fields: touched)` from the draft's base, so its text fields edit from the base's
   text (§10.1). It is never compared with `stored`, so it is neither skipped nor stale; the create
   retires the held removal, and the record keeps its untouched fields (§8.2).
   Saved: every field, an untouched one at its `folded` value, or the blank's when `folded = nil`.
6. **Update.** Otherwise:
   1. Validate the touched fields.
   2. `changed := touched fields whose stored value differs from the validated one`.
   3. `changed = ∅` → `unchanged`. Saved: the touched fields.
   4. **Stale.** If `E.savesGuarded`: `moved := {f ∈ changed, f a lattice field : stored[f] ≠
      base[f]}`; `moved ≠ ∅` → refuse `Refused(stale, subject, path: .predicted)`.
   5. Write `update(valid, fields: changed, from: draft.base, guarded: E.savesGuarded)`. The guard
      holds the written lattice fields at their `stored` stamps (engine §7.1 step 6), so a write the
      server admitted and this device had not pulled is refused `stale` there, as a notice. Saved:
      the touched fields.

### §10.3 After a refusal or a conflict

- **Stale.** The UI reads `find(id, in: .drawn)` as *theirs*.
  - *Keep mine:* `rebased(onto: theirs)`: every touched field keeps its value in `current`; every
    other field takes theirs; `base := theirs`. The next save writes only the touched fields.
    `rebased` traps on a `theirs` of another id, and on a type whose saves are not guarded; a
    guarded type has no text field (§3.4 step 8), so no text edit starts from theirs.
  - *Take theirs:* `Draft(opening: theirs)`.
- **Gone.** The record is absent: deleted, in a delete window, or a create the server refused. The
  product abandons the draft, or starts `Draft(new:)` from a blank and sets its values on `current`.
- **Another device's write.** An editor whose draft is clean opens it again when the drawn record
  changes, so it shows the merged value.

---

## §11 Standard actions

```swift
public struct SaveDraft<E: Draftable, R: ProductRefusal>: Decider {
  public init(creating value: E)                           // an executor's own new record
  public var id: ID<E> { get }                             // the draft's, or the created value's
  public var scope: ScopeRef { get }
  public func load(_ read: Reader) throws -> SaveDraftLoaded<E>
  public func decide(_ loaded: SaveDraftLoaded<E>, ids: IDSource) throws(Violation) -> Decision<Saved, R>
}
public struct SaveDraftLoaded<E: Draftable>: Sendable {
  public let drawn: E?, stored: E?, folded: E?, anchor: RecordID?
  public let moment: Moment
}
public struct Remove<E: Removable, R: ProductRefusal>: Action {
  public init(_ id: ID<E>)
  public var scope: ScopeRef { get }
  public func load(_ read: Reader) throws -> E?
  public func decide(_ loaded: E?, ids: IDSource) throws(Violation) -> Decision<Void, R>
}
public struct Move<E: Ordered, R: ProductRefusal>: Action {
  public init(_ id: ID<E>, below: ID<E>?)
  public var scope: ScopeRef { get }
  public func load(_ read: Reader) throws -> (moving: E?, above: ID<E>?)
  public func decide(_ loaded: (moving: E?, above: ID<E>?), ids: IDSource) throws(Violation) -> Decision<Void, R>
}
extension SaveDraft where E: Ordered { public init(creating value: E, placed: Placement) }
```

| Save or action | Load | Decide |
|---|---|---|
| `SaveDraft` (a draft's save, §10.1) | §10.2 | §10.2 |
| `Remove` | `find(id, in: .drawn)` | absent → `unchanged`; otherwise `remove(id)`, held per `E.heldRemoval` |
| `Move` | `find(id, in: .drawn)`, and the member above it in `drawn` order | absent → gone; `below = id`, or `below` is already the member above it → `unchanged`; otherwise `move(id, below:)` |

- A `SaveDraft` saves the draft's id. `SaveDraft(creating:)` saves a new record of a minted type, every
  field touched, as a new draft's first save does (§10.2), and refuses `Refused(id-taken, subject,
  path: .predicted)` when `drawn` or `stored` holds it. A replayed Coach call so finds its own record,
  or after the delete window an `id-spent` notice; its executor treats either `<type>.taken` (§6.3) as
  done. A drop in place writes nothing, so it never reverts another device's reorder.
- `Remove` reads `drawn`: a record the person cannot see, including one inside a delete window, is not
  removed again. Its receipt carries `gestureId` and `releaseAt` for Undo.
- **Undo** is `runner.undo(gestureId)` while the engine offers it (engine §7.3). After release the
  delete stands.
- **Referential consequences** of a removal (a routine's proposals, a session's sets) are the
  server's (engine §2.2). The client writes none of them.

---

## §12 Refusals and notices

### §12.1 `Refused`

```swift
public struct Refused: Hashable, Sendable {
  public enum Path: Hashable, Sendable { case predicted, notice }
  public let code: RefusalCode
  public let subject: RecordRef?
  public let detail: JSON?
  public let path: Path
  public var cap: (type: String, cap: Int)? { get }            // a cap refusal's detail
  public init(_ code: RefusalCode, subject: RecordRef?, detail: JSON? = nil, path: Path)
  public init(_ notice: Notice, registry: Registry)            // path: notice
}
```

The subject is, in order:
1. for a prediction or the gone check, the record the kit or product names;
2. for an engine refusal at commit: for `cap`, the first record the plan creates of `detail.type`;
   otherwise the first record the plan writes;
3. for a notice: the first delta of `content.d`; otherwise the first `ref<t>` argument of
   `content.cmd`, by the registry's argument order; otherwise none.

The detail is the engine's: `cap` carries `{type, cap}` on both paths (engine §7.1 step 8 and engine
§6.1 step 12); the server's `stale` carries `{t, id, field, current}` and a prediction carries none.

### §12.2 The product refusal

```swift
public protocol ProductRefusal: Error, Sendable {
  init(_ violation: Violation)
  init(_ refused: Refused)
  var isGeneric: Bool { get }                    // true only for the case holding an unmapped Refused
}
```

- Each product declares one refusal type for all its features. Its mapping is one total function of
  the code, the subject, the path and, for `cap` only, the detail. A code it does not expect maps to
  its generic case.
- The path is honest: `predicted` means nothing was written; `notice` means a write committed on this
  device, and possibly shown saved, was refused by the server and now lives only in the notice. Copy
  MAY differ by path, and on the `notice` path it says what was lost.

### §12.3 Notices

```swift
public struct DomainNotice<R: ProductRefusal>: Identifiable, Sendable {
  public let id: String                           // the engine notice id, for dismissal
  public let gestureId: String
  public let subject: RecordRef?                  // §12.1's notice subject
  public let refusal: R
  public let notice: Notice                       // the engine notice, with the refused content
  public init(_ notice: Notice, registry: Registry)
  public func values(of record: RecordRef) -> [String: JSON]   // what the refused content wrote to it
}
```

- `gestureId` is the text of the notice id between `notice:` and its last `/`: the id is
  `notice:<localId>` with `localId = <gestureId>/<k>` (engine §7.7 step 4, engine §7.1 step 8 and
  engine §2.5). A UI or Coach executor that showed that gesture as saved, or offered its Undo,
  withdraws the claim.
- `values(of:)` gives the fields the refused content wrote to one record, such as the `subject`, a
  text field as its text, so the UI can offer a note's text or a page's body back rather than only
  name it. It does not decode the entity: a refused update holds only the fields it changed.
- The UI observes the engine's `NoticesView(product)`, maps each notice, draws it from its refusal and
  dismisses it through the engine; a `.taken` notice of a Coach replay (§11) it dismisses undrawn.
- A notice a commit wrote while refusing its own gesture (`too-large`) never reaches the product as a
  notice: the runner dismissed it, since the run's outcome delivered the refusal (§9.2 step 7).

---

## §13 Invariants

**INV-1 Layers.** Every package and module is §2.1's and lives where §2.1 places it; a kit or
product-domain module depends on exactly the modules §2.1 lists, its closure stays in kit and engine
API, and its imports obey §2.3.

*Mechanism.* §2.4 items 1–5: declared edges, plain JVM modules and member visibility at compile time;
the closed world and the dependency matrix with rules in code, and the import and owner scans, in
`swift test` and `./gradlew check`.

**INV-2 One gesture per run.** `run` commits at most one gesture, in the same local transaction as
every read its decision used.

*Mechanism.* One decision, one plan, one `commit` (§9.2); the nested-run trap (step 1).

**INV-3 Whole or nothing.** A run writes every record of its plan or none, locally and on the server.

*Mechanism.* One local transaction; a multi-record plan is one atomic intent (§8.2); a refusal of it
folds its dependents (engine §7.7).

**INV-4 One scope.** A plan writes its action's scope. *Mechanism.* §8.3 rule 1.

**INV-5 LOCAL rules hold for what is written.** No field written through the kit breaks a LOCAL rule
of its product.

*Mechanism.* Every writing operation takes `Valid<E>` for the fields it names (§8.3 rule 6), and
`Plan(running:)` applies a command's specs (§8.4); `RegistryCheck` binds every field-bound spec to a
check on its field, every check to a written field, and every written string to a spec (§3.4 steps 5,
6 and 10); a text spec refuses U+0000, which the engine refuses (§4.3 text step 3); the same specs run
on both surfaces (§6.3).

**INV-6 Sound predictions.** A client refuses a SERVER-DECIDED rule by prediction only when the
server, holding the client's `stored` state, would refuse the write; for `stale`, the write guarded
at the stamps its base was read at.

*Mechanism.* The engine's predictions follow admission (engine §7.1 steps 2 and 8). The stale check
refuses only a changed lattice field whose `stored` value differs from the base's. Its register
therefore carries a newer stamp, so a guard at the base's stamp fails (engine §6.1 step 7). The one
exception is a prediction the write map restamped to the server's stamp while the server wrote another
value. Each product prediction is tested against the model server holding the same state (§14.3).

**INV-7 Every refusal maps.** Every declared code maps to a non-generic product refusal on both paths,
and the refusal carries its path.

*Mechanism.* Both paths construct `R(Refused(…))` (§9.2 step 7, §12.3); `RuleBookCheck`.

**INV-8 Touched fields only.** A draft's update writes exactly the touched fields the store does not
already hold; its keyed or singleton create writes exactly the touched fields, never compared with
the store. Both validate what they write, a new draft every field. A guarded update guards exactly
its written lattice fields. A minted create writes every field, and so does every save of a record
that is one fact, whatever is touched.

*Mechanism.* §10.2; `rebased` keeps only touched fields (§10.3).

**INV-9 `stored` decides, `drawn` draws.** Caps, stale checks and write positions read `stored`; what
a person acts on is read from `drawn`. The two differ only in records a held removal names.

*Mechanism.* Explicit views (§7.2); the standard actions (§10.2, §11); held plans carry removals only
(§8.3 rule 3).

**INV-10 Ids known before commit.** Every id a plan writes is resolved in decide: minted, given or
natural (§3.2). A draft's id is minted when it opens, and every save of the draft names it.

*Mechanism.* Translation emits `NewID.given` only.

**INV-11 No ambient effects.** Kit and domain code read time only from a moment, and ids only from
`IDSource`, `ActionRunner.mint`, natural keys or action input.

*Mechanism.* The determinism lint (§2.3) catches the mistakes a feature makes, not deliberate
evasion; an effect that changes an output fails the shared vectors (INV-13).

**INV-12 Registry agreement.** Every entity agrees with its registry type, and every spec stays
within its registry bounds. *Mechanism.* `RegistryCheck` (§3.4).

**INV-13 Parity.** Every behaviour §15 lists produces the same bytes in Swift and Kotlin.

*Mechanism.* The shared vectors in CI, and `RuleBookParity` (§6.3).

**INV-14 One save at a time.** A draft's saves run one after another, no edit interleaves with one,
and a refused or failed save changes nothing in the draft; a failed one committed no gesture.

*Mechanism.* `save` is synchronous, takes the draft `inout` (Kotlin: hands it to a write-back the
caller passes) and is a draft's only door, since no action returns a `Saved`; Swift UI code is
main-actor code in language mode 6 with warnings as errors, and a Kotlin save traps off its draft's
thread; `commit` throws only before its transaction commits, and the runner's dismissal only after a
refusal (§10.1, §9.2 step 7, engine §7.1).

---

## §14 The test harness

### §14.1 Two levels

Vectors pin shared behaviour byte for byte over records built from JSON, with no engine (§15). The
harness runs the real engine, a model server and devices: commits, holds, Undo, guards, races, notices.

### §14.2 The harness

```swift
public final class Harness {
  public init(registry: Registry, start: Instant, zone: any Zone = FixedZone(offsetSeconds: 0),
              seed: UInt64 = 1, account: String? = "acct-1", rules: any ServerRules = NoServerRules())
  public var runner: ActionRunner { get }
  public var clock: SimClock { get }
  public var server: ModelServerHandle { get }             // shared by every device of this harness
  public func device() -> Harness                          // another device, same account and server
  public func sync()                                       // every device's sender and puller, to quiescence
  public func advance(ms: Int64)                           // the clock; due holds release
  public func leave()                                      // engine §7.3 leaving the app
  public func failNextCommit()                             // the next commit, written or not (ER-9)
  public func drawn<E: Entity>(_ type: E.Type) throws -> [E]
  public func stored<E: Entity>(_ type: E.Type) throws -> [E]
  public func notices<R: ProductRefusal>(_ type: R.Type) throws -> [DomainNotice<R>]
  public func undoOffers() -> [UndoOffer]
}
public struct NoServerRules: ServerRules { public init() }                // a product with no server rules
public func saved<R>(_ result: SaveResult<R>) -> Bool                      // a test's result readers
public func refused<R>(_ result: SaveResult<R>) -> R?
public func failed<R>(_ result: SaveResult<R>) -> (any Error)?
public func committed<Result, Refusal>(_ outcome: Outcome<Result, Refusal>) -> Result?
public func unchanged<Result, Refusal>(_ outcome: Outcome<Result, Refusal>) -> Result?
```

`Harness` wraps the engine's `SteppedEngine`; `ServerRules`, `ModelServerHandle` and `SimClock` are
the engine's test support (ER-9). Kotlin's `Harness` has the same members over `:sync-testing`.

- **Deterministic.** No engine loop starts; `sync`, `advance` and `leave` call step functions on one
  thread of control. The clock is `SimClock`, ids come from a seeded random source, the zone is fixed.
- **Reads.** `drawn` and `stored` list in `Repository.all` order. An `UndoOffer`'s `id` is its gesture
  id, which `runner.undo` takes; `advance(ms: Constants.holdMs)` (`SyncCore`, engine Appendix B
  `HOLD_MS`) releases every hold committed before it.
- **The store** is the engine's real store held in memory (ER-9, ER-10).
- **The server** is the engine's `ModelServer`. Its generic core passes the engine's server corpus.
  A product's `ServerRules` is a double its team writes; the real server's product rules are checked
  by the engine's nightly differential run (Swift engine §9.4).
- **Scripted refusals:** `server.refuse(next:code:detail:)`, for rules the double does not model.
- **Scripted failures:** `failNextCommit()` makes the next `commit` throw before its transaction
  commits, as a full disk would, whether or not its body returns a gesture (ER-9). A UI module's own
  tests so drive its `.failed` branch.

### §14.3 What a product tests with it

- every action's outcome on the predicted path, and its notice on the server path;
- holds: commit, `undoOffers`, `advance(ms: Constants.holdMs)`, then `sync`; a keyed re-write inside
  the window and its retire;
- races: two devices both edit; the second save refuses `stale` locally, or returns as a notice;
- each product prediction against the model server holding the same state (INV-6).

```swift
@Test func secondEditorSeesStale() throws {
  let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), rules: GymServerDouble())
  let b = a.device()
  var new = Draft(new: Routine(id: a.runner.mint(Routine.self)))
  new.current.name = "Push"
  new.current.entries = [Entry(exerciseId: benchPress, restSeconds: nil, sets: nil)]
  #expect(saved(a.runner.save(&new, SaveRoutine.self))); a.sync(); b.sync()
  var mine = try #require(try a.runner.open(new.id)), theirs = try #require(try b.runner.open(new.id))
  mine.current.name = "Push A"; theirs.current.name = "Push B"
  #expect(saved(b.runner.save(&theirs, SaveRoutine.self))); b.sync(); a.sync()
  #expect(refused(a.runner.save(&mine, SaveRoutine.self)) == .stale(new.id.ref, .predicted))
}
```

### §14.4 Checks and vectors every product runs

```swift
public enum RegistryCheck {
  public static func entity<E: Writable>(_ type: E.Type, sample: E, book: RuleBook,
                                         registry: Registry) throws
  public static func entity<E: Entity>(_ type: E.Type, registry: Registry) throws    // a read-only entity
  public static func command<C: ServerCommand>(_ type: C.Type, book: RuleBook, registry: Registry) throws
}
public enum RuleBookCheck {
  public static func check<R: ProductRefusal>(_ book: RuleBook, refusal: R.Type, vectors: String) throws
}
public enum RuleBookParity { public static func check(_ book: RuleBook, file: String) throws }
public struct ProductCorpus {                                                        // §15.3
  public init(_ book: RuleBook)
  public func value(_ vector: Vector) throws -> JSON                                 // a values.json case
  public func decision<D: Decider>(of decider: D, _ vector: Vector, result: (D.Result) -> JSON,
                                   refusal: (D.Refusal) -> JSON) throws -> JSON       // an action's case
  public func save<E: Draftable, R: ProductRefusal>(_ type: SaveDraft<E, R>.Type, _ vector: Vector,
                                                   opening blank: E, edit: (inout E) -> Void,
                                                   result: (Saved) -> JSON, refusal: (R) -> JSON)
    throws -> JSON                                                                   // a draft save's case
  public func read(_ vector: Vector, in scope: ScopeRef, _ body: (Reader) throws -> JSON) throws -> JSON
}
extension Entity { public init(form: JSON) throws }                                 // {id, fields}
public enum Contract { public static func vectors(_ path: String) throws -> [Vector] }
public struct Vector: Sendable { public let file: String, name: String, input: JSON, expect: JSON }
```

Each product's tests run `RegistryCheck` for every entity (§3.4) and command (§8.4), `RuleBookCheck`
and `RuleBookParity` over its rule book (§6.3), and `ProductCorpus` over every case of its
`values.json`, each feature's `<feature>-actions.json` and each `rules/<read>.json` (§15.3),
comparing the result with the case's `expect` by JCS. `vectors`, `file` and `Contract.vectors` take
paths under `packages/api-contract/`. A feature's actions test maps each case's `action` to the
decider it names, built from the case's `input`, and gives the JSON forms of its result and its
product refusal; a draft's save runs through `save`, which opens the draft of `blank`'s id over the
case's records as `open(_:orNew:)` does, applies `edit` to its current value and decides its save,
trapping where they trap; a derived read runs through `read`, in its scope. Each reads the case's
records as the engine's readers of the decider's or read's scope do, a type of another scope throwing. These live in `DomainKitTesting`. The kit's own tests run the
kit's corpus (§15.2) and the layering tests (§2.4).

---

## §15 Shared vectors

### §15.1 Conventions

The format is the engine corpus's (engine §11.1): a `.json` file is an array of `{name, input,
expect}`; runners compare by JCS; `{error: true}` expects a failure; a file with no handler fails the
run. Records are engine §9.1 `Row`s listed per view (`drawn`, `stored`), which a runner reads as
`Record(confirmed:registry:)` (ER-17). Kit vectors use the probe registry
(`packages/api-contract/sync/probe.registry.json`) and name no product.

### §15.2 The kit's corpus: `packages/api-contract/domain-kit/`

| File | Behaviour | `input` → `expect` |
|---|---|---|
| `value/text.json` | §4.3 text: NFC, the whitespace set, U+0000, `chars` vs `bytes`, blank, bounds, `measure` | `{spec, value}` → `{value}` or `{violation}` |
| `value/number.json` | §4.3 number: rounding (1.005 → 1, 10.235 → 10.24, −0), integer, bounds after rounding | same |
| `value/choice.json` | §4.3 choice, by bytes | same |
| `value/count.json` | §4.3 count before items; the first bad item's path | `{spec, items, itemSpec}` → `{items}` or `{violation}` |
| `time/day.json` | §5.2 from instant and offset, parse, text, `adding`, `days(until:)`, `weekday` | `{op, …}` → value or `{error}` |
| `order/list.json` | §7.2 order by key then id bytes; §7.5 anchors, a held member included; §11 a move in place is `unchanged` | `{records, placement? | move?}` → `{ids}`, `{anchor}` or `{decision}` |
| `capacity/count.json` | §7.3 over `stored`, held deletes counted | `{records, type}` → `{used, cap, full}` |
| `plan/translate.json` | §8.2 every cell, text edits from an update's `base` and from `""`, anchors, `retire`, hold, exact guards, null fields, UTF-8 order; every §8.3 rule; §8.4 a command's specs applied, nested strings included | `{plan}` → `{gesture}`, `{violation}` or `{error}` |
| `run/pipeline.json` | §9.2 gone for update, remove and move; an emptied gesture → `unchanged`, a retire-only receipt → `committed`; the refusal subject | `{plan, drawn, receipt?}` → `{outcome}` |
| `draft/save.json` | §10.2 every step: a whole save of a `wholePut` type, untouched, edited, over a record another device deleted and inside a delete window, its timestamp at `now`, and refused on a check; unchanged; gone, a keyed record another device deleted included; an untouched new minted draft (refused on its checks) and a prefilled one (created); present again, new and inside a delete window, and over an invisible keyed record, whose untouched field is taken from it; already stored, `exists` included; stale; update; a text field edited from the base's text, and from `""` in a blank; `creating`, which refuses `id-taken` over a drawn or stored record | `{draft | creating, drawn, stored, anchor?, now, offsetSeconds}` → `{decision}` |
| `draft/script.json` | §10.1 and §10.3 as operation scripts: `new`, `open` (absent → nil; `orNew` on a minted type, or with a blank of another key, traps), `edit`, `save` (§10.2 over the case's records; `fail: true` fails the commit; a `current` of another id traps), `rebase` (touched and untouched fields; an unguarded type, and a `theirs` of another id, trap), and `records`, which replaces the records; the draft after each op. A refused and a failed save leave the draft as it was; a quantum field is taken rounded, and a whole save's timestamp as written | `{drawn, stored, now, offsetSeconds, ops}` → `{steps: [{draft, result?} | {trap: true}]}` |
| `refusal/subject.json` | §12.1 subjects; the notice's gesture id and `values(of:)` | `{source, plan? | notice?}` → `{subject, gestureId?, values?}` |

**JSON forms.**
- A spec: `{path, kind: "text", unit, min, max, trim, nfc}`, `{path, kind: "number", min, max,
  integer, quantum}`, `{path, kind: "choice", values}`, `{path, kind: "count", min, max}`.
- A rule: `{name, subject, kind: "local", spec?, codes?}` or `{name, subject, kind: "server", codes}`;
  an empty `codes` is omitted.
- A violation: `{rule, path, reason, …}`, the reason's members as keys.
- A gesture: `{changes, atomic, hold, guards, retire, cmd, predict, local}`. A change is `{op, t, id}`
  plus `f`, `x` (`{field: {text, from}}`), `present`, `anchor` (`{field, below}`).
- A draft: `{id, base, current, isNew, placement}`, entities as their `fields`.
- A decision: `{write: {gesture, result}}`, `{unchanged: {result}}`, or `{refuse: {violation} |
  {refused: {code, subject, detail, path}}}`.

### §15.3 A product's corpus: `packages/api-contract/<product>/`

| Path | Behaviour |
|---|---|
| `domain/rules.json` | the rule book and entity facts, pinned (§6.3) |
| `domain/values.json` | each LOCAL rule: spec cases, the kit's value-vector forms (§15.2) over a spec of the book, and entity cases (`{entity, id, fields, now, offsetSeconds}` → `{fields}` or `{violation}`) pinning check order |
| `domain/<feature>-actions.json` | each action and draft save of a feature: `{action, input, records: {drawn, stored?}, ids, now, offsetSeconds}` → `{decision}`: the action's `load` and `decision` over the records, `stored` defaulting to `drawn`, minting `ids` in order; a draft save's decision over the draft its editor opens there |
| `domain/README.md` | each action's and read's `input` and result, and the forms of the product refusal |
| `rules/<read>.json` | each derived read (§7.4; for gym, gym Coach §3.5 `rules/`): `{read, input?, records: {drawn, stored?}, firstPullComplete?, now, offsetSeconds}` → `{result}`, the read over a reader of the records in its scope at the moment, `firstPullComplete` defaulting to true |

An entity in a product's corpus is `{id, fields}`. A decision's `refuse` holds the product refusal's
form, which the product's README states.

---

## §16 Developer ergonomics

### §16.1 What a developer writes

| Piece | Where | Lines |
|---|---|---|
| Entity: type, scope, properties, init, `init(Fields)`, `fields`, `checks` | domain | 15–30 |
| Value objects, each with `init(Fields)`, `json`, `validated` | domain | 8–15 each |
| Specs and rules | domain | 4–12 |
| Standard actions | domain | 1 per action (a type alias) |
| A custom action: scope, input, load, decide | domain | 10–25 |
| The product refusal and rule book | domain, once per product | 8–25 |
| Vector cases | `packages/api-contract/<product>/domain/` | JSON |
| Harness tests | domain tests | 5–15 each |

### §16.2 Bug classes the kit removes

What the kit makes impossible is its invariants (§13), each with the mechanism that holds it. These it
makes expressible, where the product still has to use what the kit gives:

| Bug class | With |
|---|---|
| An empty account or a best asserted while the history is still booting | `firstPullComplete` (§7.4) |
| A held delete frees its cap slot early in the UI's "full" line | `Capacity` over `stored` (§7.3) |
| A notice worded as if nothing had been written | the refusal's path (§12.2) and `values(of:)` (§12.3) |
| A custom action rewrites fields its caller never set | naming the fields it writes (§8.1) |
| A saved copy, or a second open draft of one record, leaves the editor's draft on an old base | saving the draft the editor holds, in place (§10.1) |
| A UI treats a failed save as saved | a `switch` over `SaveResult` with no `default` (§10.1) |

---

## §17 Requirements on the engine API

The kit binds to the Swift engine's public API (Swift engine §5.2) and requires the following of it,
and the same of the Kotlin engine. The engine API owner accepted ER-1 to ER-9 and ER-11 to ER-18 as
stated here; ER-10 is the Kotlin engine owner's.

| ER | Requirement | Engine text it relies on |
|---|---|---|
| ER-1 | `SyncAPI` (Kotlin `:sync-api`, plain JVM) holds the values of D-2, the `Replica` port and the readers, and depends only on `SyncCore`. Every value type has a public memberwise initialiser. | Swift engine §5.2 |
| ER-2 | `Replica.commit<T>(scope, body) -> (outcome: CommitOutcome?, value: T)`: the body may return no gesture, which writes nothing and ticks no clock. It throws only before its transaction commits. | engine §7.1, the read-and-commit form |
| ER-3 | `ScopeReader` and `CommitContext` offer `stored(type)` and `drawn(type)` (visible records), lookups by id (the folded record, visible or not), `device(key)` and `firstPullComplete()`. | engine §7.6, §7.9, §2.5 `DeviceRow` |
| ER-4 | `Change.create(…, anchor: OrderAnchor?)` and `Change.move(t, id, to: OrderAnchor)`; the anchor may be a member only `stored` holds. | engine D-25, §7.1 step 4 |
| ER-5 | `Gesture.guards: [RegisterRef]` guards exactly the lattice registers named; a text field is never guarded. | engine §7.1 step 6, D-19 |
| ER-6 | `Gesture.retire: [RecordRef]` undoes held, command-free gestures whose every delta removes a named record, in the commit's transaction; `CommitReceipt.retired` lists them. | engine §7.1 step 4, §8.1, INV-10 |
| ER-7 | `CommitOutcome.refused` carries the code and a `detail`, `cap`'s being `{type, cap}`. | engine §7.1 step 8, §6.1 step 12 |
| ER-8 | `Replica.physNow()`; `CommitContext.now` is the commit's one `physNow()` read. | engine §7.1 step 4; Swift engine §5.2 |
| ER-9 | `SyncTesting` publicly offers `SteppedEngine` over an in-memory store, `ModelServer` with the `ServerRules` plug-in and scripted refusals, `SimClock`, a second device on the same server and account, and a way to make the next `commit` throw at the store's before-commit point, whether or not its body returns a gesture, so its transaction rolls back. | Swift engine §1.3, §3.1, §3.6, §9.4, §9.5 |
| ER-10 | Kotlin: `:sync-testing` runs the engine's algorithms and an in-memory store on the plain JVM, and `commit` runs on Android's main thread within a stated budget (owed). `:sync-engine` keeps its store `internal`, so no UI or platform module reaches it. | — |
| ER-11 | `SyncCore` makes public `Quantum`, built from a step (`Quantum(step)`, nil for a step that is neither an integer nor `1/k`), with `rounded(_:)` and `holds(_:)`; `MeasureUnit.chars` and `MeasureUnit.bytes` with `length(of:)`; and `Constants.holdMs`. | engine §7.1 step 4, §6.1 step 2, D-9, Appendix B |
| ER-12 | Both readers offer `drawn(type, where: field, is: id)` and `stored(…)`: the visible records of a type whose top-level `ref` field names `id`, in id-byte order, from an index, at a cost that follows the result and the scope's outbox, not the type. Any other `field` throws. The same narrowed read is offered as an observable view (a `RecordsView`), whose first load runs off the main thread and whose refresh follows the changed records, not the type. | engine D-10; Swift engine §3.3 (the ref index) |
| ER-13 | `SyncCore`, `SyncAPI` and `SyncSchema` follow §2.3's rules for the engine API: their settings, their imports, no `@_` attribute, no `#if` or availability branch. The determinism lint does not apply to them. | Swift engine §1.1 |
| ER-14 | `SyncAPI` and `:sync-api` declare `CommitFailure`, whose `kind` is one of the three failures engine §7.1 defines: `malformed`, `notWritable` or `storeFailure`. The kit traps on `malformed` and on no other kind. | engine §7.1 |
| ER-15 | The engine's package meets §2.1–§2.4 as the layering tests read it: its modules and their kinds, its package dependency, each module's imports, tools 6.2 and language mode 6, its targets' settings, a constant-data manifest, no symbolic link, and `GRDB` from `SyncStore` only. | Swift engine §1.1 |
| ER-16 | `Registry` makes public what the kit reads: per type, its identity class, life, cap and each field's kind, writer, domain, quantum and `parent`; per command, its arguments with their domains, and `predicts`. | engine §2.4 |
| ER-17 | `SyncTesting` publicly offers `Record(confirmed: Row, registry:)`: a confirmed row that no outbox entry touches, as the engine's readers hand it to a product (visible by the registry's rule, nothing pending or held, each text merged as the row says), so a product's tests build a vector's records from the modules `<P>DomainTests` may import (§2.1). | engine §7.6, §9.1 |
| ER-18 | `CommitOutcome.refused(code, detail:, notice:)`: `notice` names the notice a commit wrote while refusing its gesture (`too-large`), and is nil for every other refusal. The `Replica` port offers `dismissNotice(_ id:)`. | engine §7.1 step 8, D-17 |

## Appendix A: Example: the gym routine editor

Illustrative. The canon is [routines](../design/gym/briefs/15-the-routine.md),
[set targets](../design/gym/briefs/17-set-targets.md), [gestures](../design/gym/briefs/13-gestures.md)
and engine A.2. The routine is an aggregate of one record: its entries and their set targets are
value objects in its fields.

### A.1 Swift

```swift
import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct Routine: Draftable, Removable {
  public static let type = Gym.Types.routine
  public static let scope = Gym.scope
  public static let savesGuarded = true
  public static let heldRemoval = true

  public let id: ID<Routine>
  public var name: String
  public var entries: [Entry]

  public init(id: ID<Routine>, name: String = "", entries: [Entry] = []) { self.id = id; self.name = name; self.entries = entries }
  public init(_ r: Fields) throws(DecodeError) {
    self.init(id: ID(r.id), name: try r.string("name"), entries: try r.list("entries", of: Entry.self))
  }
  public var fields: [String: JSON] { ["name": .string(name), "entries": .array(entries.map(\.json))] }
  public static let checks: [Check<Routine>] = [
    Check("name") { r, _ in r.name = try RoutineRules.name.apply(r.name, at: "name") },
    Check("entries") { r, _ in r.entries = try RoutineRules.movements.apply(r.entries, at: "entries") },
  ]
}

public struct Entry: ValueObject {
  public var exerciseId: ID<Exercise>
  public var restSeconds: Int?
  public var sets: [SetTarget]?                               // nil: an open line

  public init(exerciseId: ID<Exercise>, restSeconds: Int?, sets: [SetTarget]?) {
    self.exerciseId = exerciseId; self.restSeconds = restSeconds; self.sets = sets
  }
  public init(_ f: Fields) throws(DecodeError) {
    self.init(exerciseId: try f.ref("exerciseId", Exercise.self), restSeconds: try f.optionalInt("restSeconds"),
              sets: try f.optionalList("sets", of: SetTarget.self))
  }
  public var json: JSON {
    .object(omittingNil: ["exerciseId": exerciseId.json, "restSeconds": restSeconds.map(JSON.init),
                          "sets": sets.map { .array($0.map(\.json)) }])
  }
  public func validated(at p: Path) throws(Violation) -> Entry {
    let sets = try RoutineRules.sets.apply(self.sets, at: p + "sets")
    return Entry(exerciseId: exerciseId, restSeconds: try RoutineRules.rest.apply(restSeconds, at: p + "restSeconds"), sets: sets)
  }
}

public struct SetTarget: ValueObject {
  public var reps: Int?                                       // nil: max
  public var weightKg: Double?                                // nil: last time

  public init(reps: Int?, weightKg: Double?) { self.reps = reps; self.weightKg = weightKg }
  public init(_ f: Fields) throws(DecodeError) { self.init(reps: try f.optionalInt("reps"), weightKg: try f.optionalDouble("weightKg")) }
  public var json: JSON { .object(omittingNil: ["reps": reps.map(JSON.init), "weightKg": weightKg.map(JSON.init)]) }
  public func validated(at p: Path) throws(Violation) -> SetTarget {
    if reps == 0 { throw RoutineRules.zero(at: p + "reps") }
    let reps = try RoutineRules.reps.apply(self.reps, at: p + "reps")
    let load = try RoutineRules.load.apply(weightKg, at: p + "weightKg")
    if load == 0 { throw RoutineRules.zero(at: p + "weightKg") }
    return SetTarget(reps: reps, weightKg: load)
  }
}

public enum RoutineRules {
  public static let name      = TextSpec("routine.name", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let movements = CountSpec("routine.entries", min: 1, max: 50)
  public static let sets      = CountSpec("routine.entries.sets", min: 1, max: 20)
  public static let reps      = NumberSpec("routine.entries.sets.reps", min: 1, max: 100, integer: true)
  public static let load      = NumberSpec("routine.entries.sets.weightKg", min: -500, max: 500, quantum: 0.01)
  public static let rest      = NumberSpec("routine.entries.restSeconds", min: 15, max: 900, integer: true)
  static func zero(at p: Path) -> Violation { Violation(rule: "routine.zeroTarget", path: p, reason: .custom("zero")) }
  static let rules: [Rule] = [.local(name), .local(movements), .local(sets), .local(reps), .local(load), .local(rest),
                              .local("routine.zeroTarget", subject: Routine.type),
                              .serverDecided("routine.movement", codes: [Gym.Codes.unknownExercise], subject: Routine.type)]
}

public typealias SaveRoutine = SaveDraft<Routine, GymRefusal>
public typealias DeleteRoutine = Remove<Routine, GymRefusal>
```

A routine is not `Ordered`: its place in the program is the integer `position` (engine A.2), which
the editor leaves unwritten and a new routine reads as 0.

`Exercise` is the gym's movement entity: an `Entity` and not `Removable`, since the binding refuses
its delete. The refusal type and the rule book are the gym product's, shared by every gym feature:

```swift
public enum GymRefusal: ProductRefusal, Equatable {
  case invalid(Violation)
  case stale(RecordRef, Refused.Path)
  case gone(RecordRef, Refused.Path)
  case taken(RecordRef, Refused.Path)
  case full(type: String, cap: Int, Refused.Path)
  case unknownMovement(Refused.Path)
  case other(Refused)

  public init(_ v: Violation) { self = .invalid(v) }
  public init(_ r: Refused) {
    switch (r.code, r.subject, r.cap) {
    case (.stale, let s?, _): self = .stale(s, r.path)
    case (.unknownRecord, let s?, _), (.recordDead, let s?, _): self = .gone(s, r.path)
    case (.idTaken, let s?, _), (.idSpent, let s?, _): self = .taken(s, r.path)
    case (.cap, _, let c?): self = .full(type: c.type, cap: c.cap, r.path)
    case (Gym.Codes.unknownExercise, _, _): self = .unknownMovement(r.path)
    default: self = .other(r)
    }
  }
  public var isGeneric: Bool { if case .other = self { return true }; return false }
}

public enum GymRules {
  public static let book = RuleBook(registry: SyncSchema.registry, entities: [Routine.self, Note.self, Exercise.self],
                                    rules: RoutineRules.rules + NoteRules.rules)
}
```

The editor's view model (UI layer):

```swift
var theirs: Routine? = nil
var draft = Draft(new: Routine(id: runner.mint(Routine.self)))                        // New routine
if let seen = try runner.open(id) { draft = seen }                                      // Edit

switch runner.save(&draft, SaveRoutine.self) {                                          // Save
case .saved: close()
case .refused(.invalid(let v)): showFirst(v)                                            // name, then movements, then rows
case .refused(.stale(let ref, _)): theirs = try runner.read(Routine.scope) { try $0.repository(Routine.self).find(ID(ref.id), in: .drawn) }
case .refused(let other): show(other)
case .failed(let error): showNotSaved(error)                                            // nothing saved; the edits stay
}
// Keep mine → draft = draft.rebased(onto: theirs!), then Save; Take theirs → draft = Draft(opening: theirs!)

if case .committed(_, let receipt) = try runner.run(DeleteRoutine(routine.id)) {       // held 9 s
  undoTransient.show(receipt.gestureId, until: receipt.releaseAt!)                     // Undo → runner.undo(gestureId)
}
```

What the kit guarantees:
- One violation at a time, in the canon's order: name, movement count, then each entry's set count
  and rows, reps before load.
- A load of `82.506` is stored as `82.51`; a target that is `0` is refused as a zero target.
- An unchanged draft writes nothing. A routine renamed on another device keeps that name when this
  device changed only its entries.
- A routine whose entries another device changed, when this device changed them too, is refused
  `stale` before anything is sent; "Keep mine" then writes this device's entries and nothing else.
- A routine an agent named with 80 characters, within the registry's 240 bytes, still saves an edit
  of its entries: only touched fields are checked.

### A.2 Kotlin sketch

```kotlin
data class Routine(override val id: Id<Routine>, val name: String = "", val entries: List<Entry> = emptyList()) : Writable<Routine> {
    override fun fields() = mapOf("name" to Json.of(name), "entries" to Json.array(entries.map { it.json() }))
    companion object : DraftType<Routine>, RemovableType<Routine> {
        override val type = Gym.Types.ROUTINE
        override val scope = Gym.SCOPE
        override val savesGuarded = true
        override val heldRemoval = true
        override fun decode(f: Fields) = Routine(Id(f.id), f.string("name"), f.list("entries", Entry))
        override val checks = listOf(
            Check<Routine>("name") { r, _ -> r.copy(name = RoutineRules.name.apply(r.name, Path("name"))) },
            Check<Routine>("entries") { r, _ -> r.copy(entries = RoutineRules.movements.apply(r.entries, Path("entries"))) },
        )
    }
}

// Entry, SetTarget, RoutineRules and GymRefusal mirror Swift; rules.json pins both surfaces.

fun deleteRoutine(id: Id<Routine>) = Remove(Routine, id, GymRefusals)
```

The editor (UI layer, main thread) holds its draft in Compose state, so a screen recomposes on an
edit and on a save:

```kotlin
class RoutineEditor(private val runner: ActionRunner, opened: Routine) {
    var draft by mutableStateOf(Draft.opening(opened)); private set
    var notSaved by mutableStateOf<Any?>(null); private set
    fun rename(name: String) { draft = draft.edit { it.copy(name = name) } }
    fun save() {
        notSaved = when (val result = runner.save(draft, Routine, GymRefusals) { draft = it }) {
            is SaveResult.Saved -> null
            is SaveResult.Refused -> result.refusal
            is SaveResult.Failed -> result.error
        }
    }
}
```

---

## Appendix B: Example: gym notes

Illustrative. The canon is [notes](../design/gym/briefs/10-notes.md),
[gestures](../design/gym/briefs/13-gestures.md) and engine A.2. An ordered list with a cap of 10: a
held delete keeps its slot until it lands; a reorder writes one `ord`; a new note goes at the bottom.
Its `note.cap`, `note.gone`, `note.stale` and `note.taken` rules are the book's standard rules (§6.3).

```swift
public struct Note: Draftable, Removable, Ordered {
  public static let type = Gym.Types.note
  public static let scope = Gym.scope
  public static let orderField = "ord"
  public static let savesGuarded = true
  public static let heldRemoval = true

  public let id: ID<Note>
  public var title: String
  public var body: String

  public init(id: ID<Note>, title: String = "", body: String = "") { self.id = id; self.title = title; self.body = body }
  public init(_ r: Fields) throws(DecodeError) { self.init(id: ID(r.id), title: try r.string("title"), body: try r.string("body", default: "")) }
  public var fields: [String: JSON] { ["title": .string(title), "body": .string(body)] }
  public static let checks: [Check<Note>] = [
    Check("title") { n, _ in n.title = try NoteRules.title.apply(n.title, at: "title") },
    Check("body") { n, _ in n.body = try NoteRules.body.apply(n.body, at: "body") },
  ]
}

public enum NoteRules {
  public static let title = TextSpec("note.title", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let body  = TextSpec("note.body", unit: .bytes, min: 0, max: 500, trim: true, nfc: true)
  static let rules: [Rule] = [.local(title), .local(body)]
}

public typealias SaveNote = SaveDraft<Note, GymRefusal>
public typealias DeleteNote = Remove<Note, GymRefusal>
public typealias MoveNote = Move<Note, GymRefusal>
```

The Notes screen (UI layer):

```swift
let notes = try Repository<Note>.decode(drawnNotes.records.values)                 // drawn, ordered by (ord, id)
let slots = Capacity(of: Note.self, stored: storedNotes.records.values, registry: registry)
let offerSeeds = storedNotes.firstPullComplete && slots.used == 0                   // never on a booting history
// slots.isFull → the Add row says "10 of 10 notes. Delete one to add another."

var draft = Draft(new: Note(id: runner.mint(Note.self)), placed: .bottom)           // a blank, id minted now
draft.current.title = typedTitle
let bodyBytes = NoteRules.body.measure(draft.current.body)                          // the editor's "n of 500 bytes"
switch runner.save(&draft, SaveNote.self) {
case .saved: closeAddRow()
case .refused(let refusal): show(refusal)                                          // the row keeps the draft
case .failed(let error): showNotSaved(error)
}

_ = try runner.run(DeleteNote(note.id))                                             // held 9 s; the slot stays taken
_ = try runner.run(MoveNote(dragged.id, below: rowAboveDropPoint?.id))              // writes dragged.ord only
```

What the kit guarantees:
- A title is NFC-normalised and trimmed with the one whitespace set, then counted in code points:
  `"  "` is `blank` and 61 code points are `tooLong` on every surface.
- A note an agent wrote keeps its title as written when the lifter edits only its body.
- A note inside its delete window still counts toward the ten, in the UI and at commit.
- A new note goes below every stored note, a held one included; a move writes one key.
- A save that races another device's tenth note returns as a `cap` notice, `.full(…, .notice)`,
  whose copy says the note was not kept.

---

## Appendix C: Example: the journal page

Illustrative. The canon is [journal](../design/journal/journal.md),
[scales](../design/journal/scales.md), [first run](../design/journal/onboarding.md) and engine A.3.
Web and iOS write pages through the engine, over the same adopted rows. Journal has no Android
surface.

### C.1 The document and its command

`Page` is a read-only `Entity`, keyed by `ID(LocalDay)`, with no life. Its body is a server-written
text field; mood, energy, source and `documentStamp` are server-written lattice fields. It is not
`Writable`, `Draftable` or `Timestamped`. The editor holds an ordinary value containing the full
body, mood, energy and source, and a dirty marker; `SaveDraft` does not save it.

A bound editor's `SavePage` action runs `journal.savePage`, with the complete document, after
any pending same-day claim has followed C.3's reconciliation:

```json
{
  "name": "journal.savePage",
  "args": {
    "day": "2026-10-01",
    "body": "The walk home was the best part.",
    "mood": 0,
    "energy": null,
    "source": "typed",
    "stamp": { "ms": 1790816400000, "counter": 0, "actor": "d-journal" }
  }
}
```

The command's local checks follow A.3, in every editor and writer:

- `day` is a real Gregorian date, with years 0001–9999; a matching date-shaped string alone is
  insufficient. It is the writer's local day, never the UTC day.
- `body` is raw text of at most 131 072 UTF-8 bytes. Its book-bound `TextSpec` has `min: 0`,
  `trim: false` and `nfc: false`; neither the command nor the editor trims or normalises it. A
  whitespace-only body remains nonempty. The engine's string and U+0000 rules still apply.
- Mood and energy are independently nullable integers 0–10. `0` is an answer; `null` clears an
  answer. Every save sends both, including nulls, rather than sending only touched fields.
- Source is `typed` or `spoken`, and each save sends it. `stamp` is the product's document HLC,
  with A.3's domain and ordering; it is not an engine register stamp.

The product keeps its content clock durably in device state. The action loads that clock, the
moment and the page's `documentStamp`, advances the content clock beyond the documents it has
observed, and commits its new clock with the command in the same local transaction. It does not
use the engine HLC, admission stamp or text revision as the document clock. A failed commit
advances neither clock nor document. Reopening, clock rollback and observing a remote winner
cannot mint a document stamp below the one already observed.

`Plan(running:predicting:)` carries the command and a prediction for the page's full body, mood,
energy, source and `documentStamp`. The prediction names no text base and requests no diff3 merge;
ordinary deltas never write the page's server-written fields. Superseded text heads and REST
metadata follow A.3 and engine Appendix D. When the command resolves the editor
reads the winner from the view; it preserves any input typed since that command was committed.
A save of an older or equal document stamp may resolve without changing the account's page.

### C.2 Durable saving and the first run

The view model saves at pauses in typing and immediately when a scale changes, on the main actor.
Native first run writes today's page only; past days remain read-only, as on web. It settles
today's dirty value before showing another day or rolling over at midnight. A refusal or store
failure keeps the unsaved input available and the editor shown. It never erases the input or
reports backup merely because an action returned `committed`.

`journalState` is a non-primary, client-written singleton. Its fields `placeholder`, `privacyLine`,
`firstPage` and `scales` are ranked strings: `pending: 0`, `retired: 1`, default `pending`. Each
retirement is monotone; a later device writing `pending` cannot re-offer it. This state follows the
user through claim and reinstall, and does not make an account hold a journal page.
Engine Appendix D fixes `firstRunPolicy = retire-existing`: an adopted account with written
pages has all four fields retired and sees no re-onboarding.

- Mood and energy are visible on first open, unasked; the invitation after keeping a page does
  not control the scales' visibility.
- First input retires `placeholder`; deleting that input does not bring the placeholder back.
- The first durable written-page save retires `privacyLine` and `firstPage` in the same plan as the page
  command. Its state delta, the bound save's content-clock device write and page command commit in one transaction;
  the command and companion delta are one atomic intent, so a refusal cannot admit only the
  retirement. The UI marks the first kept page only after that local transaction succeeds.
  The privacy fact is "Only you. No prompts, no fields, nothing to fill in — write a line or a page."
- The mood and energy invitation is due after the first page is kept, while `scales` is pending.
  An answer or **Not now** retires `scales`; neither scale is required to keep a page.

The once-per-install ink-note flag is app device settings, outside the replicated journal state.
It survives sign-in. Automatic ink requires both that flag and established absence of pages; an
unread account or a failed read never establishes absence. The layer takes no hits, keeps the
first keystroke, and nothing reopens it. Arrow frames, fonts, accessibility fallbacks and keyboard
state belong to the UI.

A save status names its real durability. Signed out, kept content is saved on this phone and the
quiet Keep invitation appears only after the scale invitation is answered or dismissed, one
invitation at a time; it opens the shell's sign-in door. Signed-in pages never show Keep.
Signed in, locally committed content is still pending backup until the account confirms it;
only then may the meta line say **backed up**.
Offline or refused content keeps its truthful local/pending state. No page shows a spinner or a
save button.

Search, voice, echoes, nudges and the week have no controls or stub actions on this iOS surface.
Their existing web computations, tables and REST doors remain as engine A.3 specifies. The page
entity does not acquire fields for those features merely because web can derive them.

### C.3 Joining work made signed out

Sign-in follows engine §7.10 and the shell's Add/Discard rule. A room whose account already holds
pages asks before adoption on web and native; an empty account adopts silently. The UI names the page count from `anonCount.page`; the decision also covers
`journalState` entries, and an unanswered question sends nothing. Work belonging to another
account never joins. The editor retains the input and its first-run state while the shell
completes this flow.

A same-day claim must preserve the account's text and append the local text according to A.3's
claim rule, with the incoming null scales preserving the account's answers. The ordinary
`journal.savePage` last-writer rule alone cannot implement that promise. Journal's claim adapter
uses `journal.claimPage`, its durable claim identity and receipt, so a retried adoption never
appends the same text twice.

While the replica is anonymous, the journal save action queues `journal.claimPage` with its full
document and a durable `claimId`. Each newer snapshot for the same day supersedes the older,
never-numbered claim gesture with engine `opts.supersede`. The replacement includes every already
retired `journalState` field that the replaced gesture carried, so replacing a page does not
restore first-run copy. The replacement and supersession commit together; a failed commit leaves
the earlier snapshot and its state intact. The journal command bridge must expose this engine
option to the action; the standard draft-save API does not supply it.

Only the latest snapshot for each day reaches the account, after the shell's explicit **Add** or
its silent adoption into an empty account. Engine §7.10 adopts those claim commands intact; no
editor writes the account's page before that decision. Binding does not make a pending same-day
claim safe to overwrite: a `savePage` stamped at T+4 is dominated by the claim's content stamp
when it reaches admission at T+100. Both may answer `ok`, with no save write, revision or notice
retaining the newer words. The action MUST follow engine A.3's pending-claim reconciliation rule.

The claim's local commit also writes `pendingClaim:<claimId>` in `device/journal`, `localOnly`:
the day, frozen claim document, latest full editor document, touched fields, cumulative first-run
retirements and the eventual successful result's epoch/seq. Anonymous supersession replaces both
claim and record atomically. Its unique claim key moves through Add without colliding with a
returning account's device rows. While the claim is pending, edits update that record durably,
including replacements, deletions, zero and explicit null scales; the editor shows the retained
document over engine prediction. No ordinary same-day `savePage` is queued yet. Process restart,
pull and sign-in preserve the record. Failed local commits retain the last durable version and
keep newer editor input unsaved; a refused claim keeps its writing with an unsaved notice.
Sign-out Keep retains the pending claim, latest edits and retirements in the account's dormant
device rows and restores them on that account's next sign-in. Discard deletes them. Install
`JournalWriting.resultWrites` and `JournalWriting.pendingWork` on the Store or test harness; the
pending-work hook adds one unsaved work item per pending claim with touched fields or retained
retirements to the sign-out count, even when its frozen claim entry already resolved. Discard pins
each pending row's full value along with its key, so an intervening edit requires a new confirmation.
Recoverable `clock-skew` and `base-unknown` refusals leave the pending claim available for retry
and reconciliation rather than recording a terminal refusal.

The command bridge records the successful claim result in its local result transaction before
generic resolution can remove the outbox entry. The reconciliation action waits for both that
result and a complete joined confirmed row, with a same-epoch live cursor covering its seq and a
successful digest check. Pull-before-result and result-before-pull both keep the latest typing.
After an epoch change, A.3 replays the exact frozen claim under its same receipt when the engine
has already resolved its entry, keeping the draft until the new result and covering pull.
It follows A.3's exact frozen-contribution replacement/account-prefix rule, with the conservative
account-first join when a concurrent rewrite makes the contribution ambiguous. Untouched fields
come from the joined row; touched fields come from the retained document, so explicit null clears.

In one read-and-commit the action observes the joined row's `documentStamp`, ticks the separate
content clock strictly above it and the durable clock, queues the reconciled full `savePage` with
its retained retirements, writes the new clock, and removes the pending record. The outbox then
durably holds the latest words. A failed commit leaves the record available for retry. Only the
reconciled save's result and covering pull justify **backed up**. If no edit followed the claim,
its result and joined pull suffice; retire the record and commit any retained first-run retirements
as a state delta in that transaction. Ordinary bound saves resume
after this reconciliation. The delayed-admission end-to-end vectors are `journal/claim-edit.json`.
