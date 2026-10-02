import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CONSTANTS } from "../../core/constants.js";
import { stampsOf } from "../../core/rows.js";
import { compareDocumentStamps } from "../../journal/product.js";
import { pendingClaimKey, reconcileClaimBody } from "../../journal/client.js";
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
  for (const { name, input, expect } of vectors.slice(1).filter((v) => v.input.edit.body)) {
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
