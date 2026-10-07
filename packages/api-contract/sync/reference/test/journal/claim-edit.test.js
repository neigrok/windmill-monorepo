import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CONSTANTS } from "../../core/constants.js";
import { stampsOf } from "../../core/rows.js";
import { compareDocumentStamps } from "../../journal/product.js";
import { editPendingClaim, onClaimPushResponse, pendingClaimKey, pendingClaimWork, queueClaim, reconcileClaimBody, reconcilePendingClaim } from "../../journal/client.js";
import { Device, Replica } from "../../client/replica.js";
import { signIn, signOut } from "../../client/lifecycle.js";
import { steadyTiming } from "../../core/clock.js";
import { Registry } from "../../core/registry.js";
import { commit } from "../../client/commit.js";
import { onPullResponse, pullRequest } from "../../client/puller.js";
import { nextPush, onPushResponse } from "../../client/sender.js";
import { admit } from "../../server/admit.js";
import { hello, pull } from "../../server/pull.js";
import { push } from "../../server/push.js";
import { ServerState } from "../../server/state.js";
import { gymProduct } from "../../vectors/gym.js";
import { ACTOR } from "../../vectors/fixtures.js";
import { journalProduct, journalRegistry } from "../../vectors/journal.js";
import { runClaimEdit } from "../../vectors/journal-claim.js";

const vectors = JSON.parse(readFileSync(new URL("../../../corpus/journal/claim-edit.json", import.meta.url)));
const row = (state) => state.rows["acct:A/journal"].find((r) => r.t === "page");
const pending = (device, id) => device.replicas[0].device?.journal?.[pendingClaimKey(id)];

test("journal/claim-edit.json replays delayed admission through sign-in, push and pull", () => {
  for (const v of vectors) assert.deepEqual(runClaimEdit(v.input), v.expect, v.name);
});

test("the prescribed eager switch succeeds twice but silently loses newer typing", () => {
  const { input, expect } = vectors[0];
  assert.equal(expect.claimResponse.body.results[0].s, "ok");
  assert.equal(expect.saveResponse.body.results[0].s, "ok");
  assert.deepEqual(expect.saveResponse.body.results[0].write, []);
  assert.equal(row(expect.server).x.body.text, "Account words.\n\nFirst words.");
  const confirmed = expect.device.replicas[0].confirmed["self/journal"].find((r) => r.t === "page");
  assert.equal(confirmed.x.body.text.includes(input.edit.body), false);
  assert.ok(!(expect.server.revisions["acct:A/journal"] ?? []).some((r) => r.text.includes(input.edit.body)));
  assert.equal(expect.device.replicas[0].notices, undefined);
  assert.equal(expect.pending, null);
});

test("durable pending edits are resaved only after the joined row and result, above its stamp", () => {
  for (const { name, input, expect } of vectors.slice(1).filter((v) => v.input.edit.body && v.input.signOut !== "discard")) {
    const claim = expect.claimResponse.body.results[0];
    const saved = expect.saveResponse.body.results[0];
    assert.equal(claim.s, "ok", name);
    assert.equal(saved.s, "ok", name);
    assert.ok(saved.write.length > 0, name);
    const edited = expect.trace.find((t) => t.op === "editCommit").device;
    assert.equal(edited.replicas[0].outbox.length, 1, name);
    assert.equal(edited.replicas[0].outbox[0].intent.cmd.name, "journal.claimPage", name);
    assert.equal(pending(edited, input.claim.claimId).latest.body, input.edit.body, name);
    for (const stage of expect.trace.filter((t) => ["beforeConfirmation", "pullBeforeResult", "resultBeforePull"].includes(t.op))) {
      assert.equal(stage.value, null, name);
      assert.equal(pending(stage.device, input.claim.claimId).latest.body, input.edit.body, name);
    }
    const claimRow = expect.trace.find((t) => t.op === "pull").device.replicas[0].confirmed["self/journal"].find((r) => r.t === "page");
    const stamp = expect.saveRequest.intents[0].cmd.args.stamp;
    assert.ok(compareDocumentStamps(stamp, claimRow.f.documentStamp[0]) > 0, name);
    const final = row(expect.server);
    assert.ok(final.x.body.text.includes(input.edit.body), name);
    assert.equal(final.x.body.text, input.occupied ? `Account words.\n\n${input.edit.body}` : input.edit.body, name);
    assert.equal(final.f.mood[0], input.edit.mood, name);
    assert.equal(final.f.energy[0], input.edit.energy ?? (input.occupied ? 3 : null), name);
    assert.equal(expect.pending, null, name);
    assert.ok(stampsOf(final).every((s) => Number(s.split(":")[0]) <= input.now + input.saveAt + CONSTANTS.MAX_SKEW_MS), name);
  }
});

test("a pending invitation dismissal is durably admitted even with no page edit", () => {
  const { input, expect } = vectors.find((v) => v.input.retirements);
  const edited = expect.trace.find((t) => t.op === "editCommit").device;
  assert.deepEqual(pending(edited, input.claim.claimId).retirements, { scales: "retired" });
  assert.equal(expect.saveRequest.intents.length, 1);
  assert.equal(expect.saveRequest.intents[0].cmd, undefined);
  assert.equal(expect.server.rows["acct:A/journal"].find((r) => r.t === "journalState").f.scales[0], "retired");
  assert.equal(row(expect.server).x.body.text, "Account words.\n\nFirst words.");
  assert.equal(expect.pending, null);
});

test("failed reconciliation commit leaves retained edits and content clock intact", () => {
  const { input, expect } = vectors.find((v) => v.input.failCommit);
  const failed = expect.trace.find((t) => t.op === "failedReconciliation");
  assert.equal(failed.value.refused, "too-large");
  assert.equal(pending(failed.device, input.claim.claimId).latest.body, input.edit.body);
  assert.equal(failed.device.replicas[0].device.journal.contentClock, undefined);
  assert.equal(expect.saveRequest.intents.length, 1);
});

test("epoch change after resolution recovers the same claim receipt and retains edited words", () => {
  const { input, expect } = vectors.find((v) => v.input.epochChange);
  const replayed = expect.trace.find((t) => t.op === "epochReplayResult").value.body.results[0];
  assert.equal(replayed.s, "ok");
  assert.deepEqual(replayed.write, []);
  assert.equal(expect.saveResponse.body.epoch, "ep-2");
  assert.equal(row(expect.server).x.body.text, `Account words.\n\n${input.edit.body}`);
  assert.equal(expect.pending, null);
});

test("local reconciliation preserves account prefix on deletion and preserves ambiguous joined text", () => {
  assert.equal(reconcileClaimBody("Account.\n\nOriginal.", "Original.", ""), "Account.");
  assert.equal(reconcileClaimBody("Original.", "Original.", "Replacement."), "Replacement.");
  assert.equal(reconcileClaimBody("Concurrent account rewrite.", "Original.", "New typing."), "Concurrent account rewrite.\n\nNew typing.");
});

test("Keep retains delayed claim edits and resumes their reconciliation after sign-in", () => {
  const input = { ...vectors[1].input, signOut: "keep" };
  const out = runClaimEdit(input);
  const question = out.trace.find((t) => t.op === "signOutQuestion").value;
  assert.equal(question.unsent, 2);
  assert.equal(question.pending, 1);
  const dormant = out.trace.find((t) => t.op === "signOut").device.replicas.find((r) => r.meta.state === "dormant");
  assert.equal(dormant.device.journal[pendingClaimKey(input.claim.claimId)].latest.body, input.edit.body);
  assert.equal(out.saveRequest.intents[0].cmd.args.body, `Account words.\n\n${input.edit.body}`);
  assert.equal(row(out.server).x.body.text, `Account words.\n\n${input.edit.body}`);
});

test("Keep counts pending edits after the frozen claim has settled", () => {
  const input = { ...vectors[1].input, signOutAfterResult: true };
  const out = runClaimEdit(input);
  const question = out.trace.find((t) => t.op === "signOutQuestion").value;
  assert.equal(question.unsent, 1);
  assert.equal(question.pending, 1);
  assert.equal(question.ready, 0);
  assert.equal(question.sent, 0);
  assert.equal(row(out.server).x.body.text, `Account words.\n\n${input.edit.body}`);
});

test("Discard purges pending claims and post-freeze edits", () => {
  const out = runClaimEdit({ ...vectors[1].input, signOut: "discard" });
  assert.equal(out.device.replicas.some((r) => r.meta.state === "dormant"), false);
  assert.equal(out.device.replicas.some((r) => r.device?.journal?.[pendingClaimKey(vectors[1].input.claim.claimId)]), false);
  assert.equal(out.pending, null);
  assert.equal(out.saveRequest, null);
});

test("recoverable clock skew never poisons pending edits before the restamped retry", () => {
  const input = { ...vectors[1].input, skewMs: CONSTANTS.MAX_SKEW_MS + vectors[1].input.claimAt + 10_000 };
  const out = runClaimEdit(input);
  assert.equal(out.trace.find((t) => t.op === "skewResult").value.body.results[0].code, "clock-skew");
  assert.equal(out.claimResponse.body.results[0].s, "ok");
    assert.ok(out.saveResponse);
    assert.equal(out.saveResponse.body.results[0].s, "ok");
  assert.equal(row(out.server).x.body.text, `Account words.\n\n${input.edit.body}`);
  assert.equal(out.pending, null);
});

test("Discard pins pending claim bytes and asks again when edits changed after the question", () => {
  const v = vectors.find((v) => v.input.occupied && !v.input.strategy);
  const device = new Device(v.expect.trace.find((t) => t.op === "editCommit").device);
  const ctx = { registry: journalRegistry, device, actor: ACTOR, deviceNow: v.input.now + v.input.editAt + 1,
    pendingDeviceWork: pendingClaimWork, ended: [], nextGestureId: () => "late", newReplicaId: () => "rp_00000000000000000000000000000002" };
  const question = signOut(device, ctx);
  assert.equal(question.pending, 1);
  const body = v.input.edit.body + " Later.";
  editPendingClaim(device.activeReplica, ctx, v.input.claim.claimId, { body });
  const changed = signOut(device, ctx, { choice: "discard", counted: question.counted });
  assert.equal(changed.complete, false);
  assert.notDeepEqual(changed.counted, question.counted);
  const kept = signOut(device, ctx, { choice: "keep", counted: question.counted });
  assert.equal(kept.complete, true);
  assert.equal(device.dormantOf("A").deviceRows("journal")[pendingClaimKey(v.input.claim.claimId)].latest.body, body);
});

test("pending journal refusals record terminal failures and exclude both automatic recoveries", () => {
  const v = vectors.find((v) => v.input.occupied && !v.input.strategy);
  const sent = v.expect.trace.find((t) => t.op === "claimSent");
  for (const code of ["clock-skew", "base-unknown", "claim-conflict"]) {
    const device = new Device(sent.device), replica = device.activeReplica;
    const ctx = { registry: journalRegistry, device, actor: ACTOR, deviceNow: v.input.now + v.input.claimAt, ended: [], telemetry: [] };
    const response = { status: 200, body: { epoch: "ep-1", as: "A", serverTime: ctx.deviceNow,
      lastN: code === "clock-skew" ? 0 : 1, results: [{ n: 1, s: "refused", code }] } };
    onClaimPushResponse(replica, ctx, sent.value, response, steadyTiming(ctx.deviceNow, ctx.deviceNow));
    assert.equal(replica.deviceRows("journal")[pendingClaimKey(v.input.claim.claimId)].refusal,
      code === "claim-conflict" ? code : null, code);
  }
});

const journalJson = JSON.parse(readFileSync(new URL("../../../journal.registry.json", import.meta.url)));
const gymJson = JSON.parse(readFileSync(new URL("../../../gym.registry.json", import.meta.url)));
const v4JournalRegistry = new Registry({ ...journalJson, version: 4, minVersion: 4 });
const composedRegistry = new Registry({ registry: "windmill", version: gymJson.version, minVersion: gymJson.minVersion,
  products: { ...gymJson.products, ...journalJson.products },
  types: [...gymJson.types, ...journalJson.types], commands: [...gymJson.commands, ...journalJson.commands] });

function gymDoorWrites(state, now) {
  const journalBefore = structuredClone({ scope: state.scope("acct:A/journal"), rows: state.rowsOf("acct:A/journal"),
    revisions: state.revisions["acct:A/journal"], claims: state.product.journalClaims });
  state.product.seeds = { dip: { name: "Dip" } };
  for (const [i, door] of ["mcp", "ask"].entries()) {
    const created = admit({ state, registry: composedRegistry, product: gymProduct, origin: { kind: "server", account: "A" },
      serverNow: now + i, intent: { scope: "self/gym", d: [{ t: "routine", id: `routine000${i + 1}`,
        born: null, life: ["alive", null], f: { name: ["Dips", null], entries: [[{ exerciseId: "dip" }], null], createdDoor: [door, null] } }] } });
    assert.equal(created.result.s, "ok");
    state = created.state;
    assert.equal(state.row("acct:A/gym", "routine", `routine000${i + 1}`).f.revision[0], 1);
  }
  assert.equal(state.row("acct:A/gym", "routineCreation", "routine0002").f.snapshot[0].revision, 1);
  assert.deepEqual({ scope: state.scope("acct:A/journal"), rows: state.rowsOf("acct:A/journal"),
    revisions: state.revisions["acct:A/journal"], claims: state.product.journalClaims }, journalBefore);
  return state;
}

test("v4 journal ready, sent and acked saves survive v6 service and gym door writes without an epoch reset", () => {
  const sample = vectors.find((v) => v.input.occupied && !v.input.strategy).input;
  for (const phase of ["ready", "sent", "acked"]) {
    let state = new ServerState(sample.server);
    let device = new Device({ active: sample.replica, replicas: [
      Replica.fresh({ replica: sample.replica, state: "bound", account: "A" }).toJSON(),
    ] });
    const ended = [], telemetry = [];
    const ctx = (at) => ({ registry: v4JournalRegistry, device, actor: ACTOR, deviceNow: sample.now + at,
      limits: CONSTANTS, ended, telemetry, appVersion: "v4", nextGestureId: () => "save-v4",
      newReplicaId: () => assert.fail("unchanged epoch cannot reidentify a journal replica") });
    const args = { day: sample.day, body: "Pending v4 save.", mood: 0, energy: null, source: "typed",
      stamp: { ms: sample.now + 1, counter: 0, actor: ACTOR } };
    commit(device.activeReplica, ctx(1), "self/journal", [], { cmd: { name: "journal.savePage", args },
      local: { contentClock: { ms: args.stamp.ms, counter: 0 } } });
    let request = phase === "ready" ? null : nextPush(device.activeReplica, ctx(2));
    if (phase === "acked") {
      const saved = push({ state, registry: v4JournalRegistry, product: journalProduct,
        account: "A", request, serverNow: sample.now + 3 });
      state = saved.state;
      onPushResponse(device.activeReplica, ctx(3), request, saved.response, steadyTiming(sample.now + 3, sample.now + 3));
    }
    assert.equal(device.activeReplica.entries()[0].state, phase);
    const pending = structuredClone(device.activeReplica.entries()[0]);
    const epoch = state.epoch;
    state = gymDoorWrites(state, sample.now + 4);
    device = new Device(device.toJSON());
    assert.deepEqual(device.activeReplica.entries()[0], pending);
    const greeting = hello({ state, registry: composedRegistry, account: "A", serverTime: sample.now + 6 });
    assert.equal(greeting.status, 200);
    assert.equal(greeting.body.schema, 6);
    assert.equal(greeting.body.minSchema, v4JournalRegistry.version);
    if (phase !== "acked") {
      request = nextPush(device.activeReplica, ctx(7));
      assert.deepEqual(request.intents[0].cmd.args, args);
      const saved = push({ state, registry: composedRegistry, product: journalProduct,
        account: "A", request, serverNow: sample.now + 7 });
      state = saved.state;
      assert.equal(saved.response.status, 200);
      assert.equal(saved.response.body.results[0].s, "ok");
      onPushResponse(device.activeReplica, ctx(7), request, saved.response, steadyTiming(sample.now + 7, sample.now + 7));
    }
    const pulledRequest = pullRequest(device.activeReplica, v4JournalRegistry, ["self/journal"]);
    const pulled = pull({ state, registry: composedRegistry, product: journalProduct,
      account: "A", request: pulledRequest, serverNow: sample.now + 8 });
    onPullResponse(device.activeReplica, ctx(8), pulledRequest, pulled.response, steadyTiming(sample.now + 8, sample.now + 8));
    assert.equal(state.epoch, epoch);
    assert.equal(device.activeReplica.meta.serverEpoch, epoch);
    assert.deepEqual(device.activeReplica.entries(), []);
    assert.deepEqual(Object.keys(device.activeReplica.cursors), ["self/journal"]);
    assert.deepEqual(device.activeReplica.confirmedRows("self/journal"), state.rowsOf("acct:A/journal"));
    assert.deepEqual(state.row("acct:A/journal", "page", sample.day).f.documentStamp[0], args.stamp);
    assert.deepEqual(telemetry, []);
  }
});

test("v4 journal pending claim and retained typing survive v6 gym writes, a lost answer and relaunch", () => {
  const sample = vectors.find((v) => v.input.occupied && !v.input.strategy).input;
  let state = new ServerState(sample.server);
  let device = new Device({ active: sample.replica, replicas: [Replica.fresh({ replica: sample.replica }).toJSON()] });
  const ended = [], telemetry = [];
  const ctx = (at) => ({ registry: v4JournalRegistry, device, actor: ACTOR, deviceNow: sample.now + at,
    limits: CONSTANTS, ended, telemetry, appVersion: "v4", nextGestureId: () => `claim-v4-${at}`,
    newReplicaId: () => assert.fail("unchanged epoch cannot reidentify a journal replica") });
  queueClaim(device.activeReplica, ctx(0), sample.claim);
  signIn(device, ctx(1), { account: "A", holdsRecords: { journal: true }, decisions: { journal: "add" } });
  const request = nextPush(device.activeReplica, ctx(2));
  editPendingClaim(device.activeReplica, ctx(3), sample.claim.claimId, sample.edit);
  const retained = structuredClone(device.activeReplica.deviceRows("journal")[pendingClaimKey(sample.claim.claimId)]);
  const epoch = state.epoch;
  state = gymDoorWrites(state, sample.now + 4);
  const admitted = push({ state, registry: composedRegistry, product: journalProduct,
    account: "A", request, serverNow: sample.now + 6 });
  state = admitted.state;
  assert.equal(admitted.response.body.results[0].s, "ok");
  const joined = state.row("acct:A/journal", "page", sample.day).x.body.text;
  device = new Device(device.toJSON());
  assert.deepEqual(device.activeReplica.deviceRows("journal")[pendingClaimKey(sample.claim.claimId)], retained);
  const retry = nextPush(device.activeReplica, ctx(7));
  assert.deepEqual(retry, request);
  const replayed = push({ state, registry: composedRegistry, product: journalProduct,
    account: "A", request: retry, serverNow: sample.now + 7 });
  assert.deepEqual(replayed.state.toJSON(), state.toJSON());
  assert.equal(replayed.state.row("acct:A/journal", "page", sample.day).x.body.text, joined);
  onClaimPushResponse(device.activeReplica, ctx(7), retry, replayed.response, steadyTiming(sample.now + 7, sample.now + 7));
  const req = pullRequest(device.activeReplica, v4JournalRegistry, ["self/journal"]);
  const pulled = pull({ state, registry: composedRegistry, product: journalProduct,
    account: "A", request: req, serverNow: sample.now + 8 });
  onPullResponse(device.activeReplica, ctx(8), req, pulled.response, steadyTiming(sample.now + 8, sample.now + 8));
  device = new Device(device.toJSON());
  assert.ok(reconcilePendingClaim(device.activeReplica, ctx(9), sample.claim.claimId));
  const saveRequest = nextPush(device.activeReplica, ctx(10));
  const saved = push({ state, registry: composedRegistry, product: journalProduct,
    account: "A", request: saveRequest, serverNow: sample.now + 10 });
  assert.equal(saved.response.body.results[0].s, "ok");
  assert.equal(saved.state.row("acct:A/journal", "page", sample.day).x.body.text,
    `Account words.\n\n${sample.edit.body}`);
  assert.equal(saved.state.epoch, epoch);
  assert.equal(device.activeReplica.meta.serverEpoch, epoch);
  assert.equal(device.activeReplica.deviceRows("journal")[pendingClaimKey(sample.claim.claimId)], undefined);
  assert.deepEqual(Object.keys(device.activeReplica.cursors), ["self/journal"]);
  assert.deepEqual(telemetry, []);
});
