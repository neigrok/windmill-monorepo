// Journal content convergence under reordered whole snapshots and repeated anonymous claims.
import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_DIGEST, replaceRow } from "../../core/digest.js";
import { jcs } from "../../core/jcs.js";
import { stampsOf } from "../../core/rows.js";
import { claimBody, JOURNAL_STATE_FIELDS } from "../../journal/product.js";
import { admit } from "../../server/admit.js";
import { ServerState } from "../../server/state.js";
import { journalProduct, journalRegistry } from "../../vectors/journal.js";
import { Rng } from "../../vectors/fixtures.js";
const runs = Number(process.env.FUZZ_N ?? 60),
  steps = Number(process.env.FUZZ_STEPS ?? 160),
  first = Number(process.env.FUZZ_SEED ?? 1);
const key = "acct:A/journal",
  T = 1760000000000;
function simulate(seed) {
  const rng = new Rng(seed),
    oracle = new Map(),
    receipts = new Map(),
    pending = [];
  // Appendix D's adopted shape at M = T: a page over its one retained revision, and the first run retired.
  const at = `${T}:0:srv`;
  const seeded = {
    day: "2026-10-01",
    body: "Legacy seed words.",
    mood: 6,
    energy: null,
    source: "typed",
    stamp: { ms: T + (seed % 3) * 1000000, counter: 2, actor: "legacy:writer" },
  };
  const archived = { ms: T - 1000, counter: 0, actor: "legacy:writer" };
  let state = ServerState.empty({
    epoch: "ep-1",
    accounts: { A: { name: "Ann" } },
  });
  const scope = state.insertScope(key, { kind: "product", owner: "A" });
  for (const row of [
    {
      t: "page",
      id: seeded.day,
      f: {
        mood: [seeded.mood, at],
        energy: [seeded.energy, at],
        source: [seeded.source, at],
        documentStamp: [seeded.stamp, at],
      },
      x: { body: { text: seeded.body, rev: 2, merged: false } },
      seq: 2,
      rc: T - 500,
      ru: T - 500,
    },
    {
      t: "journalState",
      id: "journalState",
      f: Object.fromEntries(JOURNAL_STATE_FIELDS.map((name) => [name, ["retired", at]])),
      seq: 3,
      rc: T,
      ru: T,
    },
  ]) {
    state.putRow(key, row);
    scope.digest = replaceRow(scope.digest, undefined, state.row(key, row.t, row.id));
  }
  scope.seq = 3;
  state.revisions[key] = [
    { t: "page", id: seeded.day, field: "body", rev: 1, text: "Old seed words.", archivedAt: T - 1000, documentStamp: archived },
  ];
  state.product = {
    journalRevisionProjection: { [key]: { 1: { migrationId: 1, stamp: archived, supersededAt: T - 1000 } } },
    journalPages: { [key]: { [seeded.day]: { updatedAt: T - 500 } } },
  };
  oracle.set(seeded.day, seeded);
  const seen = {
    save: 0,
    stale: 0,
    claim: 0,
    replay: 0,
    conflict: 0,
    empty: 0,
    future: 0,
  };
  for (let i = 0; i < steps; i++) {
    const now = T + i,
      day = `2026-10-${String(1 + rng.int(5)).padStart(2, "0")}`;
    let name, args;
    if (rng.chance(0.3) && pending.length) {
      ({ name, args } = rng.pick(pending));
      args = structuredClone(args);
      if (name === "journal.claimPage" && rng.chance(0.2))
        args.body += "changed";
    } else {
      const body = rng.pick(["", " ", `word ${rng.int(30)}`]),
        mood = rng.pick([null, 0, 5, 10]),
        energy = rng.pick([null, 0, 7, 10]),
        source = rng.pick(["typed", "spoken"]);
      if (rng.chance(0.3)) {
        name = "journal.claimPage";
        args = {
          day,
          body,
          mood,
          energy,
          source,
          claimId: `claim_${seed}_${String(i).padStart(4, "0")}`,
        };
      } else {
        name = "journal.savePage";
        const stamp = {
          ms: now + rng.pick([-200, -10, 0, 10000000]),
          counter: rng.int(4),
          actor: `device:${rng.int(3)}`,
        };
        args = { day, body, mood, energy, source, stamp };
        if (stamp.ms > now + 300000) seen.future++;
      }
      pending.push({ name, args });
    }
    const before = state.toJSON(),
      old = oracle.get(args.day),
      receipt = receipts.get(args.claimId);
    const out = admit({
      state,
      registry: journalRegistry,
      product: journalProduct,
      origin: { kind: rng.chance(0.5) ? "replica" : "server", account: "A" },
      intent: { scope: "self/journal", cmd: { name, args } },
      serverNow: now,
    });
    if (name === "journal.claimPage" && receipt && jcs(receipt) !== jcs(args)) {
      assert.equal(out.result.code, "claim-conflict");
      assert.deepEqual(out.state.toJSON(), before);
      seen.conflict++;
      continue;
    }
    assert.equal(out.result.s, "ok");
    state = out.state;
    if (name === "journal.savePage") {
      seen.save++;
      const a = args.stamp,
        b = old?.stamp;
      const newer =
        !b ||
        a.ms > b.ms ||
        (a.ms === b.ms &&
          (a.counter > b.counter ||
            (a.counter === b.counter && a.actor > b.actor)));
      if (newer) oracle.set(args.day, structuredClone(args));
      else {
        assert.deepEqual(state.toJSON(), before);
        seen.stale++;
      }
    } else if (receipt) {
      assert.deepEqual(state.toJSON(), before);
      seen.replay++;
    } else {
      seen.claim++;
      receipts.set(args.claimId, structuredClone(args));
      const row = state.row(key, "page", args.day);
      oracle.set(args.day, {
        ...args,
        body: claimBody(old?.body ?? "", args.body),
        mood: args.mood ?? old?.mood ?? null,
        energy: args.energy ?? old?.energy ?? null,
        stamp: row.f.documentStamp[0],
      });
      if (old) assert.ok(row.f.documentStamp[0].ms >= old.stamp.ms);
    }
    for (const [date, expected] of oracle) {
      const row = state.row(key, "page", date);
      assert.equal(row.x.body.text, expected.body);
      assert.equal(row.x.body.merged, false);
      for (const field of ["mood", "energy", "source"])
        assert.equal(row.f[field][0], expected[field]);
      assert.deepEqual(row.f.documentStamp[0], expected.stamp);
      assert.equal(row.x.body.rev, row.seq);
      assert.ok(
        stampsOf(row).every((s) => Number(s.split(":")[0]) <= now + 300000),
      );
      if (expected.body === "") seen.empty++;
    }
    const scope = state.scope(key);
    assert.equal(
      scope.digest,
      state
        .rowsOf(key)
        .reduce((d, r) => replaceRow(d, undefined, r), ZERO_DIGEST),
    );
    const revisions = state.revisions[key] ?? [];
    assert.ok(
      revisions.every(
        (r) => r.text !== "" && r.archivedAt >= now - 90 * 86400000,
      ),
    );
    assert.ok(revisions.length <= 500);
    assert.ok(
      revisions.reduce((n, r) => n + Buffer.byteLength(r.text), 0) <= 8388608,
    );
    for (const day of new Set(revisions.map((r) => r.id)))
      assert.ok(revisions.filter((r) => r.id === day).length <= 10);
  }
  return seen;
}
test(`journal replay fuzz: ${runs} runs of ${steps} steps from seed ${first}`, () => {
  const totals = {};
  for (let seed = first; seed < first + runs; seed++) {
    const seen = simulate(seed);
    for (const [k, v] of Object.entries(seen)) totals[k] = (totals[k] ?? 0) + v;
  }
  if (runs >= 60 && steps >= 160)
    for (const [event, count] of Object.entries(totals))
      assert.ok(count > 0, `journal event missing: ${event}`);
});
