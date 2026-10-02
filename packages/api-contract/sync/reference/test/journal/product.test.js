import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CONSTANTS } from "../../core/constants.js";
import { ZERO_DIGEST, replaceRow } from "../../core/digest.js";
import { jcs } from "../../core/jcs.js";
import { isVisible, stampsOf } from "../../core/rows.js";
import { backfill } from "../../journal/backfill.js";
import { nextDocumentStamp, restPage } from "../../journal/product.js";
import { admit } from "../../server/admit.js";
import { hello, pull } from "../../server/pull.js";
import { push } from "../../server/push.js";
import { ServerState } from "../../server/state.js";
import {
  journalRegistry,
  journalProduct,
  admissionVectors,
  pruneExpanded,
} from "../../vectors/journal.js";
import { runSteps } from "../../vectors/steps.js";
const load = (file) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../corpus/journal/${file}`, import.meta.url),
      "utf8",
    ),
  );
const key = "acct:A/journal";
const replay = (input) =>
  admit({
    ...input,
    state: new ServerState(input.state),
    registry: journalRegistry,
    product: journalProduct,
  });

test("prototype names are valid journal claim ids with durable exact replay receipts", () => {
  const sample = admissionVectors().find((v) => v.name === "claim empty account creates page");
  for (const claimId of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const input = structuredClone(sample.input);
    input.intent.cmd.args.claimId = claimId;
    const first = replay(input);
    assert.equal(first.result.s, "ok", claimId);
    assert.equal(Object.hasOwn(first.state.product.journalClaims[key], claimId), true, claimId);
    const again = replay({ ...input, state: first.state.toJSON() });
    assert.equal(again.result.s, "ok", claimId);
    assert.deepEqual(again.result.write, [], claimId);
    assert.deepEqual(again.state.toJSON(), first.state.toJSON(), claimId);
    const changed = structuredClone(input);
    changed.intent.cmd.args.body = "Changed.";
    changed.state = first.state.toJSON();
    assert.equal(replay(changed).result.code, "claim-conflict", claimId);
  }
});

test("journal/admit.json replays under the journal binding", () => {
  for (const { name, input, expect } of load("admit.json")) {
    const out = replay(input);
    assert.deepEqual(out.result, expect.result, name);
    assert.deepEqual(out.state.toJSON(), expect.state, name);
  }
});
test("journal save keeps strict full-document ordering and duplicate audit bodies", () => {
  const vectors = load("admit.json");
  for (const name of [
    "equal stamp retains stored bytes and scales",
    "older stamp retains row",
  ]) {
    const v = vectors.find((v) => v.name === name);
    assert.deepEqual(v.expect.state, v.input.state, name);
    assert.deepEqual(v.expect.result.write, [], name);
  }
  const scale = vectors.find(
    (v) => v.name === "scale-only save archives duplicate body",
  );
  const row = new ServerState(scale.expect.state).row(
    key,
    "page",
    "2026-10-01",
  );
  assert.equal(row.x.body.text, scale.input.state.rows[key][0].x.body.text);
  assert.equal(row.x.body.rev, row.seq);
  assert.equal(row.x.body.merged, false);
  assert.equal(scale.expect.state.revisions[key][0].text, row.x.body.text);
  assert.deepEqual(
    scale.expect.state.revisions[key][0].documentStamp,
    scale.input.state.rows[key][0].f.documentStamp[0],
  );
  assert.equal(
    scale.expect.state.revisions[key][0].archivedAt,
    scale.input.serverNow,
  );
  const blank = new ServerState(
    vectors.find(
      (v) =>
        v.name === "blank persisted resource remains in feed but invisible",
    ).expect.state,
  ).row(key, "page", "2026-10-01");
  assert.equal(isVisible(journalRegistry.type("page"), blank), false);
});
test("claim joins account-first and receipt replay cannot duplicate text", () => {
  const vectors = load("admit.json");
  const joined = vectors.find(
    (v) => v.name === "claim account-first preserves null incoming scales",
  );
  const row = new ServerState(joined.expect.state).row(
    key,
    "page",
    "2026-10-01",
  );
  assert.equal(row.x.body.text, "Account words.\n\nNew words.");
  assert.equal(row.f.mood[0], 6);
  assert.equal(row.f.energy[0], 3);
  const replayed = vectors.find(
    (v) => v.name === "claim receipt replay no writes",
  );
  assert.deepEqual(replayed.expect.state, replayed.input.state);
  assert.equal(
    vectors.find((v) => v.name === "changed claim receipt conflicts").expect
      .result.code,
    "claim-conflict",
  );
  const large = vectors.find((v) => v.name === "joined cap rolls back receipt");
  assert.equal(large.expect.result.code, "too-large");
  assert.deepEqual(large.expect.state, large.input.state);
});
test("legacy future content stamps never enter the envelope HLC", () => {
  const v = load("admit.json").find(
    (v) => v.name === "future content does not advance envelope",
  );
  const s = new ServerState(v.expect.state),
    row = s.row(key, "page", "2026-10-01");
  assert.equal(row.f.documentStamp[0].ms, v.input.intent.cmd.args.stamp.ms);
  assert.ok(
    stampsOf(row).every(
      (stamp) =>
        Number(stamp.split(":")[0]) <=
        v.input.serverNow + CONSTANTS.MAX_SKEW_MS,
    ),
  );
  assert.ok(s.clock.ms <= v.input.serverNow + CONSTANTS.MAX_SKEW_MS);
});
test("journal/backfill.json rehearses exact REST projections, digest, idempotence and boot", () => {
  for (const { name, input, expect } of load("backfill.json")) {
    if (expect.error) {
      assert.throws(
        () =>
          backfill({
            ...input,
            state: new ServerState(input.state),
            registry: journalRegistry,
          }),
        { message: expect.error },
        name,
      );
      continue;
    }
    const legacy = jcs(input.legacy);
    const s = backfill({
      ...input,
      state: new ServerState(input.state),
      registry: journalRegistry,
    });
    assert.deepEqual(s.toJSON(), expect.state, name);
    assert.equal(jcs(input.legacy), legacy, name);
    assert.deepEqual(
      backfill({ ...input, state: s, registry: journalRegistry }).toJSON(),
      expect.state,
      name,
    );
    const scope = s.scope(key);
    if (!scope) continue;
    assert.equal(
      s
        .rowsOf(key)
        .reduce(
          (digest, row) => replaceRow(digest, undefined, row),
          ZERO_DIGEST,
        ),
      scope.digest,
      name,
    );
    assert.deepEqual(
      s
        .rowsOf(key)
        .filter((r) => r.t === "page")
        .map((r) => restPage(r, s.product.journalPages[key][r.id])),
      expect.reads,
      name,
    );
    for (const row of s.rowsOf(key))
      assert.ok(
        stampsOf(row).every((stamp) => stamp === `${input.M}:0:srv`),
        name,
      );
    const boot = pull({
      state: s,
      registry: journalRegistry,
      product: journalProduct,
      account: "A",
      request: { scopes: [{ scope: "self/journal", cursor: null }] },
      serverNow: input.M,
      limits: { ...CONSTANTS, PULL_PAGE_BYTES: 1 << 30 },
    });
    assert.equal(boot.response.body.pages[0].seq, scope.seq, name);
    assert.equal(boot.response.body.pages[0].digest, scope.digest, name);
    assert.deepEqual(
      boot.response.body.pages[0].rows,
      s.rowsOf(key).sort((a, b) => a.seq - b.seq),
      name,
    );
  }
});
test("backfill refuses unmarked existing scopes and changed adoption manifests", () => {
  const v = load("backfill.json")[0];
  const s = new ServerState(v.input.state);
  s.insertScope(key, { kind: "product", owner: "A" });
  assert.throws(
    () => backfill({ ...v.input, state: s, registry: journalRegistry }),
    /without an adoption marker/,
  );
  const adopted = new ServerState(v.expect.state);
  assert.throws(
    () =>
      backfill({
        ...v.input,
        state: adopted,
        legacy: {},
        registry: journalRegistry,
      }),
    /manifest differs/,
  );
});
test("journal/revisions.json and content-clock.json replay compact vectors", () => {
  for (const { name, input, expect } of load("revisions.json"))
    assert.deepEqual(
      pruneExpanded(input).map((r) => r.rev),
      expect.kept,
      name,
    );
  for (const { name, input, expect } of load("content-clock.json"))
    assert.deepEqual(nextDocumentStamp(input), expect.stamp, name);
});
test("journal/client.json preserves latest anonymous page and cumulative first-run state", () => {
  for (const { name, input, expect } of load("client.json")) {
    const out = runSteps(input, journalRegistry);
    const last = out.returns.at(-1);
    if (last?.intents) {
      const served = push({
        state: new ServerState(input.server),
        registry: journalRegistry,
        product: journalProduct,
        account: "A",
        request: last,
        serverNow: input.serverNow,
      });
      out.server = served.state.toJSON();
      out.response = served.response;
      assert.equal(last.intents.length, 1, name);
      assert.equal(last.intents[0].cmd.args.body, "Latest words.", name);
      const row = served.state.row(key, "journalState", "journalState");
      assert.equal(row.f.firstPage[0], "retired", name);
      assert.equal(row.f.scales[0], "retired", name);
    }
    assert.deepEqual(out, expect, name);
  }
});

test("onboarding state alone does not trigger account journal adoption, blank page does not", () => {
  const stateOnly = load("admit.json").find(
    (v) => v.name === "pending cannot resurrect retired state",
  );
  const blank = load("admit.json").find(
    (v) => v.name === "blank persisted resource remains in feed but invisible",
  );
  assert.equal(
    hello({
      state: new ServerState(stateOnly.expect.state),
      registry: journalRegistry,
      account: "A",
      serverTime: blank.input.serverNow,
    }).body.holdsRecords.journal,
    false,
  );
  assert.equal(
    hello({
      state: new ServerState(blank.expect.state),
      registry: journalRegistry,
      account: "A",
      serverTime: blank.input.serverNow,
    }).body.holdsRecords.journal,
    false,
  );
});
test("audit retention boundaries have independent expected prefixes", () => {
  const vectors = load("revisions.json");
  assert.deepEqual(vectors[0].expect.kept, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(
    vectors[1].expect.kept,
    Array.from({ length: 500 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    vectors[2].expect.kept,
    Array.from({ length: 64 }, (_, i) => i + 1),
  );
  assert.deepEqual(vectors[3].expect.kept, [1]);
  assert.deepEqual(vectors[4].expect.kept, [2, 1]);
  assert.equal(vectors[5].expect.kept.length, 12);
});

test("frozen revision ordinal preserves account-wide tie order and every raw audit body", () => {
  const vectors = load("backfill.json");
  const tie = vectors.find(
    (v) => v.name === "revision tie order global across days",
  );
  const adopted = new ServerState(tie.expect.state);
  assert.deepEqual(adopted.product.journalRevisionProjection[key], {
    1: {
      migrationId: 1,
      stamp: tie.input.legacy.revisions[0].stamp,
      supersededAt: tie.input.M,
    },
    2: {
      migrationId: 2,
      stamp: tie.input.legacy.revisions[1].stamp,
      supersededAt: tie.input.M,
    },
  });
  const kept = journalProduct.pruneRevisions({
    scopeKey: key,
    productState: adopted.product,
    revisions: adopted.revisions[key],
    archived: [{ t: "page", id: "2026-10-01", field: "body" }],
    serverNow: tie.input.M,
  });
  assert.deepEqual(
    kept.map((r) => [r.rev, r.id]),
    [
      [2, "0001-01-01"],
      [1, "2026-10-02"],
    ],
  );
  const raw = vectors.find(
    (v) => v.name === "historic empty and oversized audit rows are preserved",
  );
  assert.deepEqual(
    raw.expect.state.revisions[key].map((r) => r.text),
    ["", "x".repeat(131073)],
  );
});
