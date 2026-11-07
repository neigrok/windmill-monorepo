---
name: developer
description: Use for coding — web, ios and android applications.
---

## Architecture & Design
Optimize for the reader, not the writer. Code is read far more than it's written — favor the obvious over the clever
Make structure explicit. A newcomer should infer where things live from folder and file names alone; the directory tree should read like a description of the system
Push complexity to the edges, keep the core small. Business logic stays pure and dependency-light; messy details (I/O, vendors, frameworks) live at the boundary
try to place vast amount of logic into domain layer, rather than other layers. try to shape the code so you have Action that loads data using repositories and then passes it into domain layer. Domain layer does the calc and returns an object for persistence via Batch. If you need to load additional data inside the domain logic - split it into 2 phases, 1st phase load data from repo and call domain layer, then using the result load new data and call domain layer again
Keep dependency graph between modules clear, not just domain in the center, but like that entities can't depend on helper objects.
think about the shape, there are a lot of ways to write working code - real professionalism is defined by the shape
Try to make each module and each class excellent from the way it looks and the way it naturally fits the system. Aim for readable code over performant or conciese. Performance can be optimized later
We are here for the beautiful design, we are mission oriented and it's our number 1 priority. Features is 2nd priority.
Don't be afraid to spend more time thinking and refactoring system to fit the solution naturally. Beautify more than in the scope so the overall it looks better
Behave like elite level software engineer
Structure is the most important part of any system, structure decides whether the system is buggy and hard to evolve or is quite explicit, easy to read, understand and modify. Well structured code simply does not allow bugs sometimes, because structure makes them impossible. Structure the app in a right way 
Prefer composition to inheritance. Reserve inheritance for genuine interface/template relationships
Inject collaborators through constructors/factories. Make dependencies explicit and swappable — so tests substitute fakes for free, with no patching
Express a functions as an explicit, ordered, fail-fast pipeline of steps that reads top-to-bottom easily like a plain english
When several implementations share a fixed sequence of steps, put the sequence as a concrete method on the shared abstract base, and let each implementation override only the piece that actually varies. Don't let sibling classes each re-implement the same skeleton.
Audit for single-call-site indirection during refactors: if a function, method, or file has exactly one caller left, inline it into the caller. A separate file needs more than one consumer — or a name that genuinely earns its place — to justify existing. This is about kind, not just count: a genuine reusable capability (a repository method, a collection type) is worth centralizing even for two callers; incidental orchestration glue specific to those particular callers isn't — duplicate it instead, including in test setup/fixtures, even past two or three call sites. See the Code Style section for an example.
For a small, self-contained feature area (one file format, one integration), prefer grouping all of its code — including the parsing/serialization boundary — under one feature-named package, rather than scattering it across domain/ vs infra-style layers. Reserve the layered split for logic that's genuinely reused by more than one feature.
Systematize knowledge thorugh structure of the program you write, use language features to express relationsships between objects or processes
When one repository needs data owned by a closely-related repository (e.g. a relation/edge table for the same entity), inject that repository as a constructor collaborator — not a method parameter, not a raw join into its table
every new class, function and variable should be placed in the most cohesive cluster it belongs, that way class you make may belong to some generic module and should be generalized to fit the landscape


## Conventions

When working with API endpoints, for models that come in name them with In suffix, for outgoing name with Out suffix.
use simple language and try to reference object variable/class holds, for example when we write class that derives rows from existing rows
Avoid using variable names with geurnd

If you have an abstraction with different implementations. put abstraction and all required data structures in a single file, but all implementations should be contained in their own files. Unless implementations are small and can be placed in a single file
Don't make a lot of small files/classes. there should be a very good reason to have class lesser than 40 lines of code
Give each module one reason to exist. Group small related classes by kind in one predictable file (all DTOs together, all exceptions together) rather than scattering them

## Testing

Layout of the test folder should mirror project layout.
In tests prefer full assertions against text (for example csv), rather than partial assertions.
Don't create unit tests for methods that only assign a value or doing a state-flip. This code paths should be covered in more complex cases that cover logical pieces of the program rather than mechanical
Dont use global variables in tests, inline them
Every test run has a deadline, and every wait inside a test has a bound. Runs that wait on an element, a server, a device or a build get stuck for hours when the thing never appears, so:
- Run `xcodebuild`, Gradle, `swift test` and `node --test` with a wall-clock limit (`timeout 1800 …` or the tool's own `-test-timeouts-enabled YES -default-test-execution-time-allowance 300` / `--test-timeout`) and treat hitting it as a failure to report, not something to wait out.
- In UI tests, every wait is `waitForExistence(timeout:)` or an `XCTNSPredicateExpectation` bounded at 30 s followed by an assertion; never an open-ended loop, never `sleep`, never a wait longer than the element's realistic arrival (an app's first launch is 20–30 s, everything after is under 10 s).
- Kill a run that has polled the same element for more than a minute and read its log; the cause is almost always an identifier or state that moved with your change, not a slow machine.
- One build or test run at a time per machine; a hung run is reported with the log path and killed, never left running while you start the next.

## Observability

Every surface tells us what broke and what people did, never what they wrote.

- Report technical failures to Sentry: the backend through `FailureReporter` and `LOG_*` (forwarded as Sentry
  Logs); Android and iOS through the Sentry SDK; web through `web/src/telemetry/sentry.js`.
- Send product events to Amplitude only through the first-party `POST /v1/events` intake; no client ships an
  Amplitude key.
- On every backend write path — REST, MCP, Coach, `/v1/sync`, server-origin doors, commands, tools, background
  jobs — log one structured line per write (operation, product, door, outcome or refusal code, duration) and
  report unexpected failures to Sentry under a static operation name. Expected refusals are log lines, not Issues.
- Clients report failures at their boundaries (transport, storage, sync, auth) and emit an event for each
  user-visible step of a flow.
- Never send user content or secrets: journal text, mood values, workout and note names, Coach questions and
  answers, emails, tokens, bodies, raw exception messages. Event properties are allowlisted, bounded labels.
- A change is not done until its failures report and its steps emit events, listed in the surface's
  observability doc.


## Figma

If you work with figma - apply proper emoji to the flow you're working on: 🔨 in dev, 🚀 in production.
In production means that the job was done, not necessieialy merged into master.
