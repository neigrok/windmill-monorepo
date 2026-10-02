import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CONSTANTS } from "../../core/constants.js";
import { ZERO_DIGEST, replaceRow } from "../../core/digest.js";
import { stampsOf } from "../../core/rows.js";
import { audit, backfill } from "../../journal/backfill.js";
import { JOURNAL_STATE_FIELDS, restPage } from "../../journal/product.js";
import { admit } from "../../server/admit.js";
import { pull } from "../../server/pull.js";
import { ServerState } from "../../server/state.js";
import { journalProduct, journalRegistry } from "../../vectors/journal.js";

const vectors = JSON.parse(readFileSync(new URL("../../../corpus/journal/backfill.json", import.meta.url), "utf8"));
const key = "acct:A/journal";
const adopt = (input) => backfill({ ...input, state: new ServerState(input.state), registry: journalRegistry });
const redigest = (state) => {
  state.scope(key).digest = state.rowsOf(key).reduce((digest, row) => replaceRow(digest, undefined, row), ZERO_DIGEST);
};

test("journal adoption audit checks frozen inputs independently for every account shape", () => {
  for (const { name, input, expect } of vectors) {
    if (expect.error) continue;
    assert.equal(audit({ ...input, state: adopt(input) }), true, name);
  }
});

test("written-page adoption retires every first-run control with the fixed default policy", () => {
  const input = { ...vectors[0].input };
  delete input.firstRunPolicy;
  const state = adopt(input);
  assert.deepEqual(state.row(key, "journalState", "journalState").f,
    Object.fromEntries(JOURNAL_STATE_FIELDS.map((name) => [name, ["retired", `${input.M}:0:srv`]])));
  assert.equal(state.product.journalAdoptions[key].firstRunPolicy, "retire-existing");
  assert.equal(audit({ ...input, state }), true);
  assert.deepEqual(adopt({ ...input, state: state.toJSON() }).toJSON(), state.toJSON());
  for (const firstRunPolicy of ["offer-scales", "", null]) {
    assert.throws(() => adopt({ ...input, firstRunPolicy }), /must be retire-existing/);
    assert.throws(() => audit({ ...input, firstRunPolicy, state }), /must be retire-existing/);
  }
});

test("future envelopes pass the old migration gates and poison the next write, but fail the independent audit", () => {
  const input = vectors[0].input;
  const state = adopt(input);
  const reads = state.rowsOf(key).filter((row) => row.t === "page")
    .map((row) => restPage(row, state.product.journalPages[key][row.id]));
  const future = input.legacy.pages[0].stamp.ms;
  for (const row of state.rowsOf(key)) for (const register of Object.values(row.f)) register[1] = `${future}:0:srv`;
  redigest(state);
  assert.deepEqual(state.rowsOf(key).filter((row) => row.t === "page")
    .map((row) => restPage(row, state.product.journalPages[key][row.id])), reads);
  assert.deepEqual(backfill({ ...input, state, registry: journalRegistry }).toJSON(), state.toJSON());
  const boot = pull({ state, registry: journalRegistry, product: journalProduct, account: input.account,
    request: { scopes: [{ scope: "self/journal", cursor: null }] }, serverNow: input.M,
    limits: { ...CONSTANTS, PULL_PAGE_BYTES: 1 << 30 } });
  assert.equal(boot.response.body.pages[0].digest, state.scope(key).digest);
  assert.equal(boot.response.body.pages[0].seq, state.scope(key).seq);
  assert.throws(() => audit({ ...input, state }), /envelope/);
  const saved = admit({ state, registry: journalRegistry, product: journalProduct,
    origin: { kind: "server", account: input.account }, serverNow: input.M + 1,
    intent: { scope: "self/journal", cmd: { name: "journal.savePage", args: {
      day: input.legacy.pages[0].day, body: "Next words.", mood: null, energy: null, source: "typed",
      stamp: { ms: future + 1, counter: 0, actor: "writer" },
    } } } });
  assert.equal(saved.result.s, "ok");
  assert.ok(stampsOf(saved.state.row(key, "page", input.legacy.pages[0].day))
    .every((stamp) => Number(stamp.split(":")[0]) > input.M + 1 + CONSTANTS.MAX_SKEW_MS));
});

test("journal adoption audit refuses corrupted head and receipt derivations after redigesting", () => {
  const input = vectors[0].input;
  const day = input.legacy.pages[0].day;
  const cases = [
    ["head revision", (state) => { state.row(key, "page", day).x.body.rev += 1; }],
    ["head revision", (state) => { state.row(key, "page", day).x.body.merged = true; }],
    ["rc", (state) => { state.row(key, "page", day).rc += 1; }],
    ["ru", (state) => { state.row(key, "page", day).ru += 1; }],
    ["first-run rc", (state) => { state.row(key, "journalState", "journalState").rc += 1; }],
    ["first-run registers", (state) => { state.row(key, "journalState", "journalState").f.scales[0] = "pending"; }],
    ["historical revisions", (state) => { state.revisions[key][0].rev += 100; }],
    ["page receipt projections", (state) => { state.product.journalPages[key][day].updatedAt += 1; }],
    ["revision receipt projections", (state) => { state.product.journalRevisionProjection[key]["1"].supersededAt += 1; }],
    ["recorded adoption", (state) => { state.product.journalAdoptions[key].M += 1; }],
    ["recorded adoption", (state) => { state.product.journalAdoptions[key].firstRunPolicy = "offer-scales"; }],
  ];
  for (const [label, corrupt] of cases) {
    const state = adopt(input);
    corrupt(state);
    redigest(state);
    assert.throws(() => audit({ ...input, state }), new RegExp(label), label);
  }
});
