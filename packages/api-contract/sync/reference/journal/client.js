import { commit, CommitError } from "../client/commit.js";
import { onPushResponse } from "../client/sender.js";
import { Cursor } from "../core/wire.js";
import { claimBody, nextDocumentStamp } from "./product.js";

const SCOPE = "self/journal";
const fields = ["body", "mood", "energy", "source"];
export const pendingClaimKey = (claimId) => `pendingClaim:${claimId}`;
const document = (args) => Object.fromEntries(fields.map((f) => [f, args[f]]));
const prediction = (day, doc) => [{
  op: "write", t: "page", id: day,
  f: { mood: doc.mood, energy: doc.energy, source: doc.source },
  x: { body: doc.body },
}];

export function queueClaim(replica, ctx, args, changes = [], supersede = []) {
  if (replica.meta.state !== "anon") throw new CommitError("claims are queued while anonymous");
  const local = {};
  for (const gesture of supersede) {
    const old = replica.entries(SCOPE).find((e) => e.gestureId === gesture);
    if (old?.intent.cmd?.name === "journal.claimPage")
      local[pendingClaimKey(old.intent.cmd.args.claimId)] = null;
  }
  local[pendingClaimKey(args.claimId)] = {
    day: args.day, claimId: args.claimId,
    base: document(args), latest: document(args), touched: [],
    retirements: Object.assign({}, ...changes.filter((c) => c.t === "journalState").map((c) => c.f)),
    claimResult: null, refusal: null,
  };
  return commit(replica, ctx, SCOPE, changes, {
    cmd: { name: "journal.claimPage", args },
    predict: prediction(args.day, args), supersede, local,
  });
}

export function editPendingClaim(replica, ctx, claimId, edits, retirements = {}) {
  const key = pendingClaimKey(claimId);
  const pending = structuredClone(replica.deviceRows("journal")[key]);
  if (!pending) throw new CommitError("missing pending journal claim");
  for (const name of Object.keys(edits)) {
    if (!fields.includes(name)) throw new CommitError(`unknown document field ${name}`);
    pending.latest[name] = edits[name];
    if (!pending.touched.includes(name)) pending.touched.push(name);
  }
  pending.retirements = { ...pending.retirements, ...retirements };
  return commit(replica, ctx, SCOPE, [], { local: { [key]: pending } });
}

// The product hook and the generic result handling belong to the same local transaction.
export function onClaimPushResponse(replica, ctx, request, response, timing) {
  if (response.status === 200 && !replica.isUnauthenticated(response)) {
    for (const result of response.body.results) {
      const entry = replica.entries(SCOPE).find((e) => e.state === "sent" && e.n === result.n);
      if (entry?.intent.cmd?.name !== "journal.claimPage") continue;
      const pending = replica.deviceRows("journal")[pendingClaimKey(entry.intent.cmd.args.claimId)];
      if (!pending) continue;
      if (result.s === "ok") pending.claimResult = { seq: result.seq, epoch: response.body.epoch };
      if (result.s === "refused") pending.refusal = result.code;
    }
  }
  return onPushResponse(replica, ctx, request, response, timing);
}

export function reconcileClaimBody(joined, base, latest) {
  if (joined === base) return latest;
  const suffix = `\n\n${base.trimStart()}`;
  if (base.trim() !== "" && joined.endsWith(suffix))
    return claimBody(joined.slice(0, -suffix.length), latest);
  return claimBody(joined, latest);
}

export function reconcilePendingClaim(replica, ctx, claimId) {
  const key = pendingClaimKey(claimId);
  const pending = replica.deviceRows("journal")[key];
  if (!pending || pending.refusal || !pending.claimResult) return null;
  if (replica.meta.serverEpoch !== null && pending.claimResult.epoch !== replica.meta.serverEpoch) {
    const outstanding = replica.entries(SCOPE).some((e) => e.intent.cmd?.name === "journal.claimPage" &&
      e.intent.cmd.args.claimId === claimId);
    return commit(replica, ctx, SCOPE, [], {
      ...(outstanding ? {} : { cmd: { name: "journal.claimPage", args: {
        day: pending.day, ...pending.base, claimId,
      } } }),
      local: { [key]: { ...pending, claimResult: null } },
    });
  }
  const record = replica.cursorOf(SCOPE);
  const cursor = Cursor.decode(record.cursor);
  const result = pending.claimResult;
  if (!cursor || cursor.m !== "live" || cursor.k !== undefined || record.behind ||
      record.digestStop !== undefined || record.mismatchReset || replica.staging[SCOPE] ||
      result.epoch !== replica.meta.serverEpoch || cursor.e !== result.epoch || cursor.s < result.seq)
    return null;
  const row = replica.confirmedRow(SCOPE, "page", pending.day);
  if (!row) return null;
  const changes = Object.keys(pending.retirements ?? {}).length ? [{
    op: "write", t: "journalState", id: "journalState", f: pending.retirements,
  }] : [];
  if (!pending.touched.length)
    return commit(replica, ctx, SCOPE, changes, { local: { [key]: null } });
  const doc = {
    body: pending.touched.includes("body")
      ? reconcileClaimBody(row.x.body.text, pending.base.body, pending.latest.body)
      : row.x.body.text,
    ...Object.fromEntries(["mood", "energy", "source"].map((name) => [
      name, pending.touched.includes(name) ? pending.latest[name] : row.f[name][0],
    ])),
  };
  const stamp = nextDocumentStamp({
    pair: replica.deviceRows("journal").contentClock,
    observed: row.f.documentStamp[0], now: ctx.deviceNow + replica.meta.serverOffsetMs, actor: ctx.actor,
  });
  return commit(replica, ctx, SCOPE, changes, {
    cmd: { name: "journal.savePage", args: { day: pending.day, ...doc, stamp } },
    predict: prediction(pending.day, doc),
    local: { [key]: null, contentClock: { ms: stamp.ms, counter: stamp.counter } },
  });
}
