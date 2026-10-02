import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CONSTANTS } from "../../core/constants.js";
import { stampsOf } from "../../core/rows.js";
import { compareDocumentStamps } from "../../journal/product.js";
import { editPendingClaim, onClaimPushResponse, pendingClaimKey, pendingClaimWork, reconcileClaimBody } from "../../journal/client.js";
import { Device } from "../../client/replica.js";
import { signOut } from "../../client/lifecycle.js";
import { steadyTiming } from "../../core/clock.js";
import { ACTOR } from "../../vectors/fixtures.js";
import { journalRegistry } from "../../vectors/journal.js";
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
