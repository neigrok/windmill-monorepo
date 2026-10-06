import { CONSTANTS } from "../../../../src/platform/sync/core/constants.js";
import { steadyTiming } from "../../../../src/platform/sync/core/clock.js";
import { scopeDigest } from "../../../../src/platform/sync/core/digest.js";
import { commit } from "../../../../src/platform/sync/client/commit.js";
import { epochChange, signIn, signOut } from "../../../../src/platform/sync/client/lifecycle.js";
import { Device, Replica } from "../../../../src/platform/sync/client/replica.js";
import { onPullResponse, pullRequest } from "../../../../src/platform/sync/client/puller.js";
import { nextPush, onPushResponse } from "../../../../src/platform/sync/client/sender.js";
import {
  editPendingClaim, onClaimPushResponse, pendingClaimKey, pendingClaimWork, queueClaim, reconcilePendingClaim,
} from "../../../../src/products/journal/claims.js";
import { nextDocumentStamp } from "../../../../src/platform/sync/core/content.js";
import { pull } from "../../../../../packages/api-contract/sync/reference/server/pull.js";
import { push } from "../../../../../packages/api-contract/sync/reference/server/push.js";
import { ServerState } from "../../../../../packages/api-contract/sync/reference/server/state.js";
import { ACTOR, vector } from "./fixtures.js";
import { journalRegistry, journalProduct } from "./journal.js";

export function runClaimEdit(input) {
  const { now, day, claim, edit, claimAt, editAt, saveAt } = input;
  let device = new Device({ active: input.replica, replicas: [Replica.fresh({ replica: input.replica }).toJSON()] });
  let state = new ServerState(input.server);
  let gestures = 0;
  const skewMs = input.skewMs ?? 0;
  const trace = [], ended = [], telemetry = [], events = [];
  const ctx = (at) => ({
    registry: journalRegistry, device, actor: ACTOR, deviceNow: now + at + skewMs,
    limits: CONSTANTS, ended, telemetry, events, nextGestureId: () => `g${++gestures}`,
    pendingDeviceWork: pendingClaimWork,
    newReplicaId: () => "rp_00000000000000000000000000000002",
    newActor: () => ACTOR,
  });
  const timing = (at) => steadyTiming(now + at + skewMs, now + at + skewMs);
  const snapshot = (op, value = null) => trace.push({ op, value, device: structuredClone(device.toJSON()) });
  const leaveAndReturn = (choice, at) => {
    snapshot("signOutQuestion", signOut(device, ctx(at)));
    snapshot("signOut", signOut(device, ctx(at), { choice }));
    device = new Device(device.toJSON());
    snapshot("signedOutRestart");
    if (choice === "keep") snapshot("signIn", signIn(device, ctx(at + 1), {
      account: "A", holdsRecords: { journal: input.occupied },
    }));
  };
  const claimChanges = skewMs ? [{ op: "write", t: "journalState", id: "journalState", f: { firstPage: "retired" } }] : [];
  const queue = input.strategy === "eager" ? commit(device.activeReplica, ctx(0), "self/journal", [], {
    cmd: { name: "journal.claimPage", args: claim },
    predict: [{ op: "write", t: "page", id: day, x: { body: claim.body } }],
  }) : queueClaim(device.activeReplica, ctx(0), claim, claimChanges);
  snapshot("claimCommit", queue);
  signIn(device, ctx(1), {
    account: "A", holdsRecords: { journal: input.occupied },
    ...(input.occupied ? { decisions: { journal: "add" } } : {}),
  });
  let request = nextPush(device.activeReplica, ctx(2));
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
  if (input.signOut) {
    leaveAndReturn(input.signOut, editAt + 1);
    if (input.signOut === "discard") return { trace, device: device.toJSON(), server: state.toJSON(),
      claimResponse: null, saveRequest: null, saveResponse: null, pending: null };
    request = nextPush(device.activeReplica, ctx(editAt + 2));
    snapshot("claimRetriedAfterSignIn", request);
  }
  let served = push({ state, registry: journalRegistry, product: journalProduct,
    account: "A", request, serverNow: now + claimAt });
  state = served.state;
  if (skewMs) {
    onClaimPushResponse(device.activeReplica, ctx(claimAt), request, served.response, timing(claimAt));
    snapshot("skewResult", served.response);
    device = new Device(device.toJSON());
    request = nextPush(device.activeReplica, ctx(claimAt + 1));
    snapshot("skewRetry", request);
    served = push({ state, registry: journalRegistry, product: journalProduct,
      account: "A", request, serverNow: now + claimAt + 1 });
    state = served.state;
  }
  const applyPull = (at) => {
    const request = pullRequest(device.activeReplica, journalRegistry, ["self/journal"]);
    const pulled = pull({ state, registry: journalRegistry, product: journalProduct,
      account: "A", request, serverNow: now + at });
    snapshot("pull", onPullResponse(device.activeReplica, ctx(at), request, pulled.response,
      timing(at)));
  };
  if (input.pullFirst) {
    applyPull(claimAt + 1);
    snapshot("pullBeforeResult", reconcilePendingClaim(device.activeReplica, ctx(claimAt + 1), claim.claimId));
    device = new Device(device.toJSON());
  }
  (input.strategy === "eager" ? onPushResponse : onClaimPushResponse)(
    device.activeReplica, ctx(claimAt + 2), request, served.response,
    timing(claimAt + 2));
  snapshot("claimResult", served.response);
  if (!input.pullFirst) {
    if (input.strategy !== "eager")
      snapshot("resultBeforePull", reconcilePendingClaim(device.activeReplica, ctx(claimAt + 2), claim.claimId));
    applyPull(claimAt + 2);
  }
  if (input.restart) device = new Device(device.toJSON());
  if (input.signOutAfterResult) {
    leaveAndReturn("keep", saveAt - 2);
    applyPull(saveAt - 1);
  }
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
      timing(saveAt));
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
      timing(saveAt));
    snapshot("saveResult", saveResponse);
    applyPull(saveAt + 1);
  }
  return { trace, device: device.toJSON(), server: state.toJSON(),
    claimResponse: served.response, saveRequest, saveResponse,
    pending: device.activeReplica.deviceRows("journal")[pendingClaimKey(claim.claimId)] ?? null };
}

