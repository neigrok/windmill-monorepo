# Journal domain corpus

These shared expectations are written from [domain-kit Appendix C](../../../../docs/foundation/domain-kit.md#appendix-c-example-the-journal-page)
and [engine A.3](../../../../docs/foundation/engine.md#a3-journal), with the kit's §3–§4 and §8 defining
validation and gesture forms. The specification is the oracle. An implementation disagreement changes
the implementation, never an expectation to accommodate a surface. Every surface carrying journal
must claim every file. Swift and web runners fail on an unclaimed file. Web also replays every
value/action scene with its records reversed.

## Files

| File | Cases |
|---|---|
| `rules.json` | One complete rule book: two entity facts and 18 rules |
| `values.json` | 132 cases: bound specs, both command checks, state, content stamps and clocks, pending edits and contribution reconciliation |
| `page-actions.json` | 44 cases: bound and anonymous saves, retirements, supersession, retained edits, confirmation proofs and reconciliation |

`rules.json` is the gym corpus's `{entities,rules}` object. The other files are arrays of
`{name,input,expect}` with unique names, compared by JCS equality. The common
[kit forms](../../domain-kit/README.md) define specs, violations, engine rows and gestures. The
registry is `../../sync/journal.registry.json`; no implementation supplies expected values.

## Values and checks

A complete document is `{body,mood,energy,source}`. Both nullable scale members are required;
zero is an answer and null clears it. Body bytes remain verbatim, including whitespace and
canonically equivalent Unicode spellings. The 131072-byte boundary cases contain literal input
and expected text, not an implementation-generated digest or abbreviated body.

| Input | Expect |
|---|---|
| `{spec,value}` | `{value}` or `{violation}`, using the kit's spec forms |
| `{op:"command",command:"SavePage"\|"ClaimPage",args}` | `{args}` after the command and its bound string specs validate; `{violation}` or `{error:true}` on failure |
| `{entity:"journalState",id:"journalState",fields,now,offsetSeconds}` | `{fields}` with all four defaults, or `{violation}` |
| `{op:"ContentClock.valid",stamp}` | `{valid}` |
| `{op:"ContentClock.advance",clock,observed,now,actor}` | `{stamp}` or `{error:true}` on clock exhaustion |
| `{op:"PendingClaim.reconcileBody",joined,base,latest}` | `{body}` |
| `{op:"PendingClaim.edit",pending,document,retiring}` | `{pending}` |

Command `args` are the complete engine arguments: `day` and the four document fields, plus
`stamp` for `SavePage` or `claimId` for `ClaimPage`. Malformed typed inputs, including impossible
Gregorian dates, missing required arguments and fractional or string scales, use `{error:true}`.
That means the runner cannot construct the typed command; it must not coerce, default or truncate
them. Valid days can be past or future at this level. The editor's today-only policy is the
`SavePage` action's separate check.

Content stamps are `{ms,counter,actor}`; a durable content clock is only `{ms,counter}`.
`observed:null` means no observed page stamp. Printable ASCII actors include space and colon;
only `{ms:0,counter:0,actor:""}` permits an empty actor. These values are product data, independent
of engine envelope stamps. Counter overflow carries into safe milliseconds; exhaustion fails
without a new stamp.

The durable pending form is:

```json
{
  "day": "2026-10-01",
  "claimId": "claim01",
  "base": {"body": "Local", "mood": null, "energy": null, "source": "typed"},
  "latest": {"body": "Edited", "mood": 0, "energy": null, "source": "typed"},
  "touched": ["body", "mood"],
  "retirements": {"placeholder": "retired"},
  "claimResult": null,
  "refusal": null
}
```

`base` is the frozen claimed document, not the account's page. `claimResult` is null or
`{epoch,seq}`; `refusal` is null or a code. Edits retain both, union touched fields and retirements,
and replace the complete latest document. Reverting an edited field still counts as touching it.
`touched` is a set, represented in UTF-8 byte order in comparisons, including pending device
writes. Receipt ids from the deterministic test id source stand for the production CSPRNG ids;
these fixtures do not test entropy.

## Actions

An action scene is `{action,input,records:{drawn,stored?,confirmed?},ids,now,offsetSeconds,actor}`,
with optional `anonymous`, `devices`, `commands` and `checkpoint`. `stored` defaults to `drawn`;
`confirmed` defaults to `stored`. Device entries are `{key:value}`, including `contentClock` and
`pendingClaim:<claimId>`. Absent device rows and commands mean none, `anonymous` defaults false,
and ids are consumed in order. Vectors specify the moment and writer actor explicitly.

A queued command is `{gestureId,command:{name,args},canSupersede,isAdmitted?}`. A checkpoint is
`{epoch,cleanSeq}`, both nullable: `cleanSeq` exists only for a complete, digest-checked live
cursor, without partial-row, boot, behind or digest-failure state. It must cover the result seq
in that result's epoch. A drawn prediction alone is never a confirmed joined row.

| Action | Input | Result |
|---|---|---|
| `SavePage`, `ClaimPage` | `{day,document,retiring?}` | Claim id for anonymous or retained pending work; null for an ordinary bound save |
| `RetireJournalInvitation` | `{field}` | null |
| `ReconcileClaim` | `{day,claimId}` | true once reconciled or confirmed without edits; false while waiting, refusing unsafe reconciliation, or replaying an old-epoch receipt |

A decision is `{decision:{write:{gesture,result}}}`, `{decision:{unchanged:{result}}}` or
`{decision:{refuse:<JournalRefusal>}}`. Refusals use `{invalid:<violation>}`, `{tooLarge:true}`,
`{claimConflict:true}` or `{other:<refused>}`. The last form retains the complete kit refusal.

Gestures use all eight kit keys and add `supersede:[gestureId]` only when nonempty. Journal's
keyed and singleton writes use `op:"write"` without an anchor; page prediction text uses
`x.body:{text,from:null}`. A bound prediction carries the complete document and `documentStamp`.
A claim predicts the document, with its future server-minted content stamp omitted. Device writes
are compared in UTF-8 key order; they target unique keys in these scenes. `atomic:false` follows
kit §8.2: one ordinary singleton write needs no multi-record flag, and a command already groups
its companion delta into the same atomic intent.

## Spec rulings

- **Raw text and strict arguments (C.1, A.3).** No trim, NFC, numeric coercion, omitted scale,
  invalid Gregorian day or unrecognised source is accepted. Body and receipt limits count UTF-8
  bytes. Both command string paths and writable state strings have book-bound specs (§3.4, §8.4).
- **Retirements (C.2, A.3 First run).** Text input retires `placeholder`; the first durable
  written-page save also retires `privacyLine` and `firstPage`. A non-null scale, including zero,
  retires `scales` independently. A scale-only page is written and retires `privacyLine` and
  `firstPage`, while `placeholder` remains pending until text input. Retirements remain
  monotone, and anonymous replacement retains all earlier retirements even after the page is emptied.
  Repeating an already-retired value is permitted: kit §8.2 and engine §7.1 remove equal field
  writes during commit. A pure decision need not suppress that redundant plan.
- **Pending edits (C.3, A.3).** Binding or a refusal does not grant permission to enqueue a fresh
  same-day save or claim. Edits remain under their original pending receipt until safe reconciliation;
  a new claim could append the original words twice. The retained field set records byte changes,
  including composed/decomposed Unicode and explicit nulls.
- **Contribution replacement (A.3).** Exact frozen-body equality replaces that contribution. An
  exact `"\n\n" + ltrim(base)` suffix identifies an account prefix; deleting the contribution
  preserves it. Ambiguous concurrent rewrites preserve the complete confirmed prose and join the
  latest contribution account first. Trimming uses ECMAScript whitespace; U+0085 is content.
- **Confirmation and replay (C.3, A.3).** Both the durable successful result and a same-epoch,
  clean covering pull are required. Either arrival order can wait safely. A resolved entry across
  an epoch change replays exactly the frozen command and same receipt, retaining edits and clearing
  only its obsolete result. An unresolved entry recovers through the engine; clearing its obsolete
  result locally is also permitted if the command and retained writing remain intact. No-edit confirmation
  removes the pending row and commits retained retirements without a redundant page save.
- **Content clock (C.1, C.3, A.3).** Bound and reconciled saves tick above the observed page and
  durable pair, even during physical-clock rollback. The command, full prediction, clock write,
  retained state delta and pending removal form one local commit. Exhaustion leaves writing
  available for retry. A failed commit must do the same; domain decisions cannot themselves prove
  transactional failure behavior.
- **Reconciled body cap (C.1, C.3, A.3).** Account prose and the latest contribution can each fit
  while their join exceeds 131072 bytes. Refuse that full save without removing the pending row
  or committing the candidate clock; the retained writing remains available.

The engine's separate [`claim-edit.json`](../../sync/corpus/journal/claim-edit.json) corpus covers delayed admission,
restart and reordered responses. This corpus pins pure decisions and values; local commit failure
and engine durability remain harness gates.

## Surface coverage

Swift and web claim all three files. Each compares the complete rule book and every value/action
expectation; no surface supplies expected values.

| Corpus | Comparisons |
|---|---:|
| `rules.json` | 1 |
| `values.json` | 132 |
| `page-actions.json` | 44 |
| Total | 177 |

The web domain applies the rulings throughout its commands, editor actions and reconciliation:

- Strict Gregorian days, complete scale arguments, integer bounds, raw body bytes, source and
  receipt validation happen locally; command string paths and writable state strings have bound specs.
- Bound and reconciled predictions include the exact minted `documentStamp` and complete document.
- Text input retires `placeholder`; scale-only answers and Not now preserve a pending placeholder.
  Anonymous replacement retains all earlier retirements even after clearing the page.
- Editor saves enforce local today; historical claim and reconciliation commands remain legal.
- NUL and clock exhaustion return declared refusals. Oversized reconciled bodies retain pending
  writing and the durable clock.
- Refused pending edits retain their receipt and latest document without queueing a new appending claim.

Both surfaces preserve a zero-only written page, byte distinctions in pending edits, and exact
contribution replacement with conservative account-first joining. Repeated equal retirement plans
and clearing obsolete results during unresolved recovery remain permitted differences. Internal
editor-draft deletion is not a cross-surface device protocol.

Web's persisted engine and Chromium tests cover local transaction aborts, reload, offline writing,
multiple tabs and receipt arrival order in addition to these pure comparisons. The engine's separate
claim corpus continues checking its own binding.
