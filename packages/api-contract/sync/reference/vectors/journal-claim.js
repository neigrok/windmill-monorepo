import { CONSTANTS } from "../core/constants.js";
import { steadyTiming } from "../core/clock.js";
import { scopeDigest } from "../core/digest.js";
import { commit } from "../client/commit.js";
import { epochChange, signIn } from "../client/lifecycle.js";
import { Device, Replica } from "../client/replica.js";
import { onPullResponse, pullRequest } from "../client/puller.js";
import { nextPush, onPushResponse } from "../client/sender.js";
import {
  editPendingClaim, onClaimPushResponse, pendingClaimKey, queueClaim, reconcilePendingClaim,
} from "../journal/client.js";
import { nextDocumentStamp } from "../journal/product.js";
import { pull } from "../server/pull.js";
import { push } from "../server/push.js";
import { ServerState } from "../server/state.js";
import { ACTOR, vector } from "./fixtures.js";
import { journalRegistry, journalProduct, admissionVectors } from "./journal.js";

export function runClaimEdit(input) {
  const { now, day, claim, edit, claimAt, editAt, saveAt } = input;
  let device = new Device({ active: input.replica, replicas: [Replica.fresh({ replica: input.replica }).toJSON()] });
  let state = new ServerState(input.server);
  let gestures = 0;
  const trace = [], ended = [], telemetry = [], events = [];
  const ctx = (at) => ({
    registry: journalRegistry, device, actor: ACTOR, deviceNow: now + at,
    limits: CONSTANTS, ended, telemetry, events, nextGestureId: () => `g${++gestures}`,
    newReplicaId: () => "rp_00000000000000000000000000000002",
    newActor: () => ACTOR,
  });
  const snapshot = (op, value = null) => trace.push({ op, value, device: device.toJSON() });
  const queue = input.strategy === "eager" ? commit(device.activeReplica, ctx(0), "self/journal", [], {
    cmd: { name: "journal.claimPage", args: claim },
    predict: [{ op: "write", t: "page", id: day, x: { body: claim.body } }],
  }) : queueClaim(device.activeReplica, ctx(0), claim);
  snapshot("claimCommit", queue);
  signIn(device, ctx(1), {
    account: "A", holdsRecords: { journal: input.occupied },
    ...(input.occupied ? { decisions: { journal: "add" } } : {}),
  });
  const request = nextPush(device.activeReplica, ctx(2));
  snapshot("claimSent", request);
  if (input.strategy === "eager") {
    const stamp = nextDocumentStamp({ now: now + editAt, actor: ACTOR });
    const { claimId, ...args } = { ...claim, ...edit, stamp };
    snapshot("editCommit", commit(device.activeReplica, ctx(editAt), "self/journal", [], {
      cmd: { name: "journal.savePage", args },
      predict: [{ op: "write", t: "page", id: day, x: { body: edit.body } }],
      local: { contentClock: { ms: stamp.ms, counter: stamp.counter } },
    }));
  } else {
    snapshot("editCommit", editPendingClaim(device.activeReplica, ctx(editAt), claim.claimId, edit, input.retirements));
    snapshot("beforeConfirmation", reconcilePendingClaim(device.activeReplica, ctx(editAt), claim.claimId));
  }
  if (input.restart) {
    device = new Device(device.toJSON());
    snapshot("restart");
  }
  const served = push({ state, registry: journalRegistry, product: journalProduct,
    account: "A", request, serverNow: now + claimAt });
  state = served.state;
  const applyPull = (at) => {
    const request = pullRequest(device.activeReplica, journalRegistry, ["self/journal"]);
    const pulled = pull({ state, registry: journalRegistry, product: journalProduct,
      account: "A", request, serverNow: now + at });
    snapshot("pull", onPullResponse(device.activeReplica, ctx(at), request, pulled.response,
      steadyTiming(now + at, now + at)));
  };
  if (input.pullFirst) {
    applyPull(claimAt + 1);
    snapshot("pullBeforeResult", reconcilePendingClaim(device.activeReplica, ctx(claimAt + 1), claim.claimId));
    device = new Device(device.toJSON());
  }
  (input.strategy === "eager" ? onPushResponse : onClaimPushResponse)(
    device.activeReplica, ctx(claimAt + 2), request, served.response,
    steadyTiming(now + claimAt + 2, now + claimAt + 2));
  snapshot("claimResult", served.response);
  if (!input.pullFirst) {
    if (input.strategy !== "eager")
      snapshot("resultBeforePull", reconcilePendingClaim(device.activeReplica, ctx(claimAt + 2), claim.claimId));
    applyPull(claimAt + 2);
  }
  if (input.restart) device = new Device(device.toJSON());
  if (input.epochChange) {
    state.epoch = "ep-2";
    epochChange(device.activeReplica, ctx(saveAt), "ep-2");
    snapshot("epochReplayCommit", reconcilePendingClaim(device.activeReplica, ctx(saveAt), claim.claimId));
    device = new Device(device.toJSON());
    const replayRequest = nextPush(device.activeReplica, ctx(saveAt));
    const replayed = push({ state, registry: journalRegistry, product: journalProduct,
      account: "A", request: replayRequest, serverNow: now + saveAt });
    state = replayed.state;
    onClaimPushResponse(device.activeReplica, ctx(saveAt), replayRequest, replayed.response,
      steadyTiming(now + saveAt, now + saveAt));
    snapshot("epochReplayResult", replayed.response);
    applyPull(saveAt);
  }
  let outcome = null;
  if (input.strategy !== "eager") {
    if (input.failCommit) {
      snapshot("failedReconciliation", reconcilePendingClaim(device.activeReplica,
        { ...ctx(saveAt), limits: { ...CONSTANTS, PUSH_MAX_BYTES: 1 } }, claim.claimId));
      device = new Device(device.toJSON());
    }
    outcome = reconcilePendingClaim(device.activeReplica, ctx(saveAt), claim.claimId);
    snapshot("reconcile", outcome);
  }
  const saveRequest = nextPush(device.activeReplica, ctx(saveAt));
  let saveResponse = null;
  if (saveRequest) {
    const saved = push({ state, registry: journalRegistry, product: journalProduct,
      account: "A", request: saveRequest, serverNow: now + saveAt });
    state = saved.state;
    saveResponse = saved.response;
    onPushResponse(device.activeReplica, ctx(saveAt), saveRequest, saveResponse,
      steadyTiming(now + saveAt, now + saveAt));
    snapshot("saveResult", saveResponse);
    applyPull(saveAt + 1);
  }
  return { trace, device: device.toJSON(), server: state.toJSON(),
    claimResponse: served.response, saveRequest, saveResponse,
    pending: device.activeReplica.deviceRows("journal")[pendingClaimKey(claim.claimId)] ?? null };
}

export function files() {
  const empty = admissionVectors().find((v) => v.name === "new whole page").input.state;
  const occupied = admissionVectors().find((v) => v.name === "equal stamp retains stored bytes and scales").input.state;
  const day = "2026-10-01", now = 1760000000000;
  const claim = { day, body: "First words.", mood: null, energy: null, source: "typed", claimId: "claim_delayed_01" };
  const base = { now, day, claim, edit: { body: "First words. New signed-in words.", mood: 0 },
    replica: "rp_00000000000000000000000000000001", editAt: 4000, claimAt: 100000, saveAt: 100003 };
  const cases = [
    ["prescribed eager save loses post-sign-in words at delayed claim admission", { strategy: "eager", occupied: true, server: occupied }],
    ["delayed occupied claim preserves typing across restart and resaves newer", { occupied: true, server: occupied, restart: true }],
    ["delayed empty-account claim preserves typing across restart", { occupied: false, server: empty, restart: true }],
    ["joined pull before result cannot release durable typing", { occupied: true, server: occupied, pullFirst: true, restart: true }],
    ["epoch change after claim resolution replays the same receipt without appending", { occupied: true, server: occupied, pullFirst: true, restart: true, epochChange: true }],
    ["failed reconciliation commit retains draft then retries once", { occupied: true, server: occupied, failCommit: true, restart: true }],
    ["pending edits replace anonymous body and explicitly clear account scale", { occupied: true, server: occupied, edit: { body: "Replacement signed-in words.", mood: null, energy: 0 } }],
    ["invitation dismissal while claim pending survives without a text edit", { occupied: true, server: occupied, edit: {}, retirements: { scales: "retired" }, restart: true }],
    ["future account content stamp is observed only at reconciliation", { occupied: true, server: (() => {
      const s = structuredClone(occupied);
      s.rows["acct:A/journal"][0].f.documentStamp[0].ms = now + 10000000;
      const state = new ServerState(s);
      state.scope("acct:A/journal").digest = scopeDigest(state.rowsOf("acct:A/journal"));
      return state.toJSON();
    })() }],
  ];
  return { "journal/claim-edit.json": cases.map(([name, extra]) => {
    const input = { ...base, ...extra };
    return vector(name, input, runClaimEdit(input));
  }) };
}
