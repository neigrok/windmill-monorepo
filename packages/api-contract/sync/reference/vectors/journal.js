// Journal admission, retention, content-clock and client vectors.
import { readFileSync } from "node:fs";
import { CONSTANTS } from "../core/constants.js";
import { replaceRow } from "../core/digest.js";
import { Registry } from "../core/registry.js";
import { JournalProduct, nextDocumentStamp } from "../journal/product.js";
import { admit } from "../server/admit.js";
import { ServerState } from "../server/state.js";
import { push } from "../server/push.js";
import { Device, Replica } from "../client/replica.js";
import { ACTOR, vector } from "./fixtures.js";
import { runSteps } from "./steps.js";
export const journalRegistry = new Registry(
  JSON.parse(readFileSync(new URL("../../journal.registry.json", import.meta.url), "utf8")),
);
export const journalProduct = new JournalProduct();
const NOW = 1760000000000,
  DAY = "2026-10-01",
  KEY = "acct:A/journal";
const ORIGIN = {
  kind: "replica",
  account: "A",
  replica: "rp_00000000000000000000000000000001",
  n: 1,
};
const SERVER = { kind: "server", account: "A" };
const content = (ms = NOW - 100, counter = 0, actor = "old:writer") => ({
  ms,
  counter,
  actor,
});
const args = (edit = {}) => ({
  day: DAY,
  body: "New words.",
  mood: null,
  energy: null,
  source: "typed",
  stamp: content(),
  ...edit,
});
const claimArgs = (edit = {}) => {
  const { stamp, ...out } = args(edit);
  return { ...out, claimId: edit.claimId ?? "claim_00000001" };
};
const command = (name, args, d) => ({
  scope: "self/journal",
  cmd: { name, args },
  ...(d ? { d } : {}),
});
const save = (a, d) => command("journal.savePage", args(a), d);
const claim = (a, d) => command("journal.claimPage", claimArgs(a), d);
const regs = (f, stamp) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, [v, stamp]]));
const page = (edit = {}) => ({
  t: "page",
  id: DAY,
  f: regs(
    { mood: 6, energy: 3, source: "typed", documentStamp: content(NOW - 200) },
    `${NOW - 200}:0:srv`,
  ),
  x: { body: { text: "Account words.", rev: 1, merged: false } },
  seq: 1,
  rc: NOW - 200,
  ru: NOW - 200,
  ...edit,
});
const empty = () =>
  ServerState.empty({
    epoch: "ep-1",
    accounts: { A: { name: "Ann" }, B: { name: "Bob" } },
  }).toJSON();
function state(rows = [], revisions = [], product = {}) {
  const s = new ServerState(empty()),
    scope = s.insertScope(KEY, { kind: "product", owner: "A" });
  for (const row of rows) {
    s.putRow(KEY, row);
    scope.digest = replaceRow(
      scope.digest,
      undefined,
      s.row(KEY, row.t, row.id),
    );
  }
  scope.seq = Math.max(
    0,
    ...rows.map((r) => r.seq),
    ...revisions.map((r) => r.rev),
  );
  if (revisions.length) s.revisions[KEY] = structuredClone(revisions);
  s.product = structuredClone(product);
  return s.toJSON();
}
function admission(
  name,
  intent,
  before = state(),
  origin = ORIGIN,
  serverNow = NOW,
) {
  const outcome = admit({
    state: new ServerState(before),
    registry: journalRegistry,
    product: journalProduct,
    origin,
    intent,
    serverNow,
    limits: CONSTANTS,
  });
  return vector(
    name,
    { state: before, origin, intent, serverNow },
    { result: outcome.result, state: outcome.state.toJSON() },
  );
}
export function admissionVectors() {
  const old = state([page()]);
  const out = [
    admission("new whole page", save()),
    admission("server-origin whole page", save(), old, SERVER),
    admission(
      "equal stamp retains stored bytes and scales",
      save({ stamp: content(NOW - 200), body: "Tie loser.", mood: 10 }),
      old,
    ),
    admission(
      "older stamp retains row",
      save({ stamp: content(NOW - 300) }),
      old,
    ),
    admission(
      "counter orders content",
      save({ stamp: content(NOW - 200, 1) }),
      old,
    ),
    admission(
      "actor orders content including colon",
      save({ stamp: content(NOW - 200, 0, "z:writer") }),
      old,
    ),
    admission(
      "future content does not advance envelope",
      save({ stamp: content(NOW + 999999999) }),
      old,
    ),
    admission(
      "unset legacy stamp accepted",
      save({ stamp: content(0, 0, "") }),
    ),
    admission(
      "nonzero empty actor refused",
      save({ stamp: content(1, 0, "") }),
    ),
    admission(
      "blank persisted resource remains in feed but invisible",
      save({ body: "" }),
    ),
    admission(
      "scale-only save archives duplicate body",
      save({ body: "Account words.", mood: 0, energy: 10 }),
      old,
    ),
    admission("clearing archives nonempty body", save({ body: "" }), old),
    admission(
      "empty outgoing head is not archived",
      save(),
      state([page({ x: { body: { text: "", rev: 1, merged: false } } })]),
    ),
    admission(
      "replacement clears merged without diff3",
      save(),
      state([
        page({ x: { body: { text: "Account words.", rev: 1, merged: true } } }),
      ]),
    ),
    admission(
      "first durable page and state atomic",
      save({}, [
        {
          t: "journalState",
          id: "journalState",
          f: regs(
            {
              placeholder: "retired",
              privacyLine: "retired",
              firstPage: "retired",
              scales: "retired",
            },
            `${NOW}:0:${ACTOR}`,
          ),
        },
      ]),
    ),
    admission(
      "pending cannot resurrect retired state",
      {
        scope: "self/journal",
        d: [
          {
            t: "journalState",
            id: "journalState",
            f: regs(
              { firstPage: "pending", scales: "pending" },
              `${NOW}:0:${ACTOR}`,
            ),
          },
        ],
      },
      state([
        {
          t: "journalState",
          id: "journalState",
          f: regs(
            { firstPage: "retired", scales: "retired" },
            `${NOW - 100}:0:srv`,
          ),
          seq: 1,
          rc: NOW - 100,
          ru: NOW - 100,
        },
      ]),
    ),
    admission(
      "replica bare delta forbidden",
      {
        scope: "self/journal",
        d: [{ t: "page", id: DAY, f: regs({ mood: 0 }, `${NOW}:0:${ACTOR}`) }],
      },
      old,
    ),
    admission(
      "server bare delta forbidden",
      {
        scope: "self/journal",
        d: [{ t: "page", id: DAY, f: { mood: [0, null] } }],
      },
      old,
      SERVER,
    ),
    admission(
      "internal marker cannot be smuggled",
      {
        scope: "self/journal",
        d: [
          {
            t: "page",
            id: DAY,
            x: { body: { text: "bad", base: { rev: 1 }, replace: true } },
          },
        ],
      },
      old,
      SERVER,
    ),
    admission(
      "bare delta beside command forbidden",
      save({}, [{ t: "page", id: DAY, f: { mood: [0, null] } }]),
      old,
      SERVER,
    ),
    admission(
      "claim account-first preserves null incoming scales",
      claim(),
      old,
    ),
    admission(
      "claim incoming zero scale and source win",
      claim({ mood: 0, energy: 10, source: "spoken" }),
      old,
    ),
    admission("claim empty account creates page", claim()),
    admission(
      "claim whitespace account yields local exact bytes",
      claim({ body: " local \n" }),
      state([page({ x: { body: { text: " \n", rev: 1, merged: false } } })]),
    ),
    admission(
      "claim whitespace local preserves account",
      claim({ body: " \n" }),
      old,
    ),
    admission(
      "claim recognizes included account paragraph",
      claim({ body: "Before\nAccount words.\nAfter" }),
      old,
    ),
    admission(
      "claim observes future legacy clock and carries counter",
      claim(),
      state([
        page({
          f: regs(
            {
              mood: 6,
              energy: 3,
              source: "typed",
              documentStamp: content(NOW + 10000000, 4294967295),
            },
            `${NOW - 200}:0:srv`,
          ),
        }),
      ]),
    ),
  ];
  for (const day of [
    "0000-01-01",
    "2026-02-29",
    "1900-02-29",
    "2026-13-01",
    "2026-04-31",
  ])
    out.push(admission(`invalid calendar ${day}`, save({ day })));
  for (const day of ["0001-01-01", "2000-02-29", "9999-12-31"])
    out.push(admission(`valid calendar ${day}`, save({ day })));
  for (const [name, edit] of [
    ["fractional mood", { mood: 1.5 }],
    ["bad energy", { energy: 11 }],
    ["strict source", { source: "bad" }],
    ["ms bound", { stamp: content(2 ** 53) }],
    ["counter bound", { stamp: content(NOW, 2 ** 32) }],
    ["actor controls", { stamp: content(NOW, 0, "\n") }],
    ["actor length", { stamp: content(NOW, 0, "x".repeat(65)) }],
  ])
    out.push(admission(name, save(edit)));
  const missing = save();
  delete missing.cmd.args.body;
  out.push(admission("missing body invalid", missing));
  out.push(
    admission(
      "raw oversized body checked before stale",
      save({ body: "😀".repeat(32769), stamp: content(0, 0, "") }),
      old,
    ),
  );
  out.push(
    admission("raw body at byte cap", save({ body: "😀".repeat(32768) })),
  );
  const first = admission("claim receipt first", claim(), old);
  out.push(
    first,
    admission("claim receipt replay no writes", claim(), first.expect.state),
    admission(
      "changed claim receipt conflicts",
      claim({ body: "different" }),
      first.expect.state,
    ),
  );
  for (const claimId of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const first = admission(`claim prototype id ${claimId} first`, claim({ claimId }), old);
    out.push(first,
      admission(`claim prototype id ${claimId} replay`, claim({ claimId }), first.expect.state),
      admission(`claim prototype id ${claimId} changed conflicts`, claim({ claimId, body: "different" }), first.expect.state));
  }
  out.push(
    admission(
      "joined cap rolls back receipt",
      claim({ body: "x".repeat(131061) }),
      old,
    ),
  );
  // Appendix D's adopted shape: a head over the cap and the retired first run, at the adoption's stamp.
  const adopted = `${NOW}:0:srv`;
  out.push(
    admission(
      "valid save replaces oversized adopted head",
      save(),
      state(
        [
          page({
            f: regs(
              {
                mood: null,
                energy: null,
                source: "typed",
                documentStamp: content(NOW + 10000000, 42, "legacy:actor"),
              },
              adopted,
            ),
            x: { body: { text: "x".repeat(131073), rev: 1, merged: false } },
            rc: NOW - 900,
            ru: NOW - 900,
          }),
          {
            t: "journalState",
            id: "journalState",
            f: regs(
              {
                placeholder: "retired",
                privacyLine: "retired",
                firstPage: "retired",
                scales: "retired",
              },
              adopted,
            ),
            seq: 2,
            rc: NOW,
            ru: NOW,
          },
        ],
        [],
        { journalPages: { [KEY]: { [DAY]: { updatedAt: NOW - 900 } } } },
      ),
    ),
  );
  return out;
}
export function pruneExpanded(input) {
  return journalProduct.pruneRevisions({
    scopeKey: KEY,
    productState: {},
    serverNow: input.serverNow,
    archived: input.days.map((id) => ({ t: "page", id, field: "body" })),
    revisions: input.revisions.map(({ day: id, bytes, ...rest }) => ({
      t: "page",
      id,
      field: "body",
      text: "x".repeat(bytes),
      ...rest,
    })),
  });
}
export function revisionVectors() {
  return [
    [
      "ten per day retains duplicate bodies",
      Array.from({ length: 12 }, (_, i) => ({
        day: DAY,
        rev: i + 1,
        bytes: 4,
        archivedAt: NOW - i,
      })),
      [DAY],
    ],
    [
      "five hundred per account",
      Array.from({ length: 502 }, (_, i) => ({
        day: `day${i}`,
        rev: i + 1,
        bytes: 1,
        archivedAt: NOW - i,
      })),
      ["day0"],
    ],
    [
      "8 MiB inclusive prefix",
      Array.from({ length: 65 }, (_, i) => ({
        day: `day${i}`,
        rev: i + 1,
        bytes: 131072,
        archivedAt: NOW - i,
      })),
      ["day0"],
    ],
    [
      "ninety day inclusive edge",
      [
        { day: DAY, rev: 1, bytes: 1, archivedAt: NOW - 90 * 86400000 },
        { day: DAY, rev: 2, bytes: 1, archivedAt: NOW - 90 * 86400000 - 1 },
      ],
      [DAY],
    ],
    [
      "same instant newest revision first",
      [
        { day: DAY, rev: 1, bytes: 1, archivedAt: NOW },
        { day: DAY, rev: 2, bytes: 1, archivedAt: NOW },
      ],
      [DAY],
    ],
    [
      "daily pruning only touches archived day",
      Array.from({ length: 12 }, (_, i) => ({
        day: "untouched",
        rev: i + 1,
        bytes: 1,
        archivedAt: NOW,
      })),
      [DAY],
    ],
  ].map(([name, revisions, days]) => {
    const input = { revisions, days, serverNow: NOW };
    return vector(name, input, {
      kept: pruneExpanded(input).map((r) => r.rev),
    });
  });
}
export function clockVectors() {
  return [
    [
      "future payload observed independently",
      {
        pair: { ms: 0, counter: 0 },
        observed: content(NOW + 10000000, 3),
        now: NOW,
        actor: "ios:writer",
      },
    ],
    [
      "counter carry",
      { pair: { ms: NOW, counter: 4294967295 }, now: NOW, actor: "ios:writer" },
    ],
    [
      "physical advances",
      { pair: { ms: 1, counter: 9 }, now: NOW, actor: "ios:writer" },
    ],
  ].map(([name, input]) =>
    vector(name, input, { stamp: nextDocumentStamp(input) }),
  );
}
export function clientVectors() {
  const fresh = (bound = false) =>
    new Device({
      active: ORIGIN.replica,
      replicas: [
        Replica.fresh({
          replica: ORIGIN.replica,
          state: bound ? "bound" : "anon",
          ...(bound ? { account: "A" } : {}),
        }).toJSON(),
      ],
    }).toJSON();
  const firstArgs = claimArgs({ body: "First words." }),
    latestArgs = claimArgs({
      body: "Latest words.",
      mood: 0,
      claimId: "claim_00000002",
    });
  const first = {
    op: "commit",
    scope: "self/journal",
    deviceNow: NOW,
    changes: [
      {
        op: "write",
        t: "journalState",
        id: "journalState",
        f: {
          placeholder: "retired",
          privacyLine: "retired",
          firstPage: "retired",
          scales: "pending",
        },
      },
    ],
    opts: {
      cmd: { name: "journal.claimPage", args: firstArgs },
      predict: [
        {
          op: "put",
          t: "page",
          id: DAY,
          f: { mood: null, energy: null, source: "typed" },
          x: { body: firstArgs.body },
        },
      ],
    },
  };
  const next = {
    ...first,
    deviceNow: NOW + 1,
    changes: [
      {
        op: "write",
        t: "journalState",
        id: "journalState",
        f: {
          placeholder: "retired",
          privacyLine: "retired",
          firstPage: "retired",
          scales: "retired",
        },
      },
    ],
    opts: {
      ...first.opts,
      supersede: ["g1"],
      cmd: { name: "journal.claimPage", args: latestArgs },
      predict: [
        {
          op: "put",
          t: "page",
          id: DAY,
          f: { mood: 0, energy: null, source: "typed" },
          x: { body: latestArgs.body },
        },
      ],
    },
  };
  return [
    [
      "latest snapshot state preserved, binds empty account",
      false,
      false,
      [
        first,
        next,
        { op: "view", scope: "self/journal", withHeld: true },
        { op: "signIn", account: "A", holdsRecords: { journal: false } },
        { op: "push", deviceNow: NOW + 2 },
      ],
    ],
    [
      "latest snapshot claims occupied account",
      false,
      true,
      [
        first,
        next,
        {
          op: "signIn",
          account: "A",
          holdsRecords: { journal: true },
          decisions: { journal: "add" },
        },
        { op: "push", deviceNow: NOW + 2 },
      ],
    ],
    [
      "bound ready cannot supersede; throw leaves prior snapshot",
      true,
      false,
      [first, next],
    ],
    [
      "missing gesture supersede atomic throw",
      false,
      false,
      [first, { ...next, opts: { ...next.opts, supersede: ["absent"] } }],
    ],
    [
      "duplicate gesture supersede atomic throw",
      false,
      false,
      [first, { ...next, opts: { ...next.opts, supersede: ["g1", "g1"] } }],
    ],
    [
      "numbered bound entry cannot supersede",
      false,
      false,
      [
        first,
        { op: "signIn", account: "A", holdsRecords: { journal: false } },
        { op: "push", deviceNow: NOW + 2 },
        next,
      ],
    ],
    [
      "malformed replacement leaves old snapshot",
      false,
      false,
      [
        first,
        {
          ...next,
          changes: [
            {
              op: "write",
              t: "journalState",
              id: "journalState",
              f: { unknown: "retired" },
            },
          ],
        },
      ],
    ],
    [
      "bound save atomically persists separate device content clock",
      true,
      false,
      [
        {
          op: "commit",
          scope: "self/journal",
          deviceNow: NOW,
          changes: [],
          opts: {
            cmd: {
              name: "journal.savePage",
              args: args({ stamp: content(NOW + 10000000, 4, "ios:writer") }),
            },
            predict: [
              { op: "write", t: "page", id: DAY, x: { body: "New words." } },
            ],
            local: { contentClock: { ms: NOW + 10000000, counter: 4 } },
          },
        },
      ],
    ],
    [
      "failed bound local commit keeps separate clock unchanged",
      true,
      false,
      [
        {
          op: "commit",
          scope: "self/journal",
          deviceNow: NOW,
          changes: [
            { op: "write", t: "page", id: DAY, x: { body: "forbidden" } },
          ],
          opts: { local: { contentClock: { ms: NOW + 10000000, counter: 4 } } },
        },
      ],
    ],
  ].map(([name, bound, occupied, steps]) => {
    const input = {
      device: fresh(bound),
      steps,
      server: occupied ? state([page()]) : state(),
      serverNow: NOW + 3,
    };
    const expect = runSteps(input, journalRegistry);
    const last = expect.returns.at(-1);
    if (last?.intents) {
      const served = push({
        state: new ServerState(input.server),
        registry: journalRegistry,
        product: journalProduct,
        account: "A",
        request: last,
        serverNow: input.serverNow,
      });
      expect.server = served.state.toJSON();
      expect.response = served.response;
    }
    return vector(name, input, expect);
  });
}
export function files() {
  return {
    "journal/admit.json": admissionVectors(),
    "journal/revisions.json": revisionVectors(),
    "journal/content-clock.json": clockVectors(),
    "journal/client.json": clientVectors(),
  };
}
