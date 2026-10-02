// Appendix A.3: whole-page journal saves, account-first claims and bounded audit revisions.

import { createHash } from "node:crypto";
import { COUNTER_LIMIT, MS_LIMIT } from "../core/constants.js";
import { jcs } from "../core/jcs.js";
import { ownValue, setOwn } from "../core/maps.js";
import { Stamp } from "../core/stamp.js";
import { Refusal, replacementText } from "../server/admit.js";

export const MAX_PAGE_BYTES = 131072;
export const JOURNAL_STATE_FIELDS = [
  "placeholder",
  "privacyLine",
  "firstPage",
  "scales",
];
const RETENTION_MS = 90 * 86_400_000;

export function isCalendarDay(day) {
  if (typeof day !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day))
    return false;
  const [year, month, date] = day.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    date >= 1 &&
    date <=
      [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

export function isDocumentStamp(stamp) {
  return (
    stamp !== null &&
    typeof stamp === "object" &&
    !Array.isArray(stamp) &&
    Object.keys(stamp).sort().join() === "actor,counter,ms" &&
    Number.isSafeInteger(stamp.ms) &&
    stamp.ms >= 0 &&
    stamp.ms < MS_LIMIT &&
    Number.isSafeInteger(stamp.counter) &&
    stamp.counter >= 0 &&
    stamp.counter < COUNTER_LIMIT &&
    typeof stamp.actor === "string" &&
    /^[ -~]{0,64}$/.test(stamp.actor) &&
    (stamp.actor !== "" || (stamp.ms === 0 && stamp.counter === 0))
  );
}

export function compareDocumentStamps(a, b) {
  return (
    a.ms - b.ms ||
    a.counter - b.counter ||
    (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0)
  );
}

// The content clock observes a page's payload, never the engine's envelope clock.
export function nextDocumentStamp({
  pair = { ms: 0, counter: 0 },
  observed,
  now,
  actor,
}) {
  if (typeof actor !== "string" || !/^[ -~]{1,64}$/.test(actor))
    throw new Refusal("invalid");
  let { ms, counter } = pair;
  if (
    observed &&
    (observed.ms > ms || (observed.ms === ms && observed.counter > counter))
  )
    ({ ms, counter } = observed);
  if (now > ms) {
    ms = now;
    counter = 0;
  } else if (++counter === COUNTER_LIMIT) {
    ms += 1;
    counter = 0;
  }
  const stamp = { ms, counter, actor };
  if (!isDocumentStamp(stamp)) throw new Refusal("invalid");
  return stamp;
}

export function claimBody(account, here) {
  if (account.trim() === "") return here;
  if (here.trim() === "") return account;
  if (here.includes(account.trim())) return here;
  return `${account.trimEnd()}\n\n${here.trimStart()}`;
}

export function restPage(row, projection) {
  if (!row) return null;
  const stamp = row.f.documentStamp[0];
  return {
    day: row.id,
    body: row.x.body.text,
    mood: row.f.mood[0],
    energy: row.f.energy[0],
    source: row.f.source[0],
    stamp: Stamp.encode(stamp),
    updatedAt: projection.updatedAt,
  };
}

function book(ctx, name) {
  ctx.productState[name] ??= {};
  return (ctx.productState[name][ctx.scopeKey] ??= {});
}

function checkedBody(body) {
  if (Buffer.byteLength(body, "utf8") > MAX_PAGE_BYTES)
    throw new Refusal("too-large");
}

export class JournalProduct {
  constructor() {
    this.revisionsKept = Infinity;
  }

  isReplay(ctx, cmd) {
    return (
      cmd.name === "journal.claimPage" &&
      Object.hasOwn(book(ctx, "journalClaims"), cmd.args.claimId)
    );
  }

  runCommand(ctx, cmd) {
    if (!isCalendarDay(cmd.args.day)) throw new Refusal("invalid");
    checkedBody(cmd.args.body);
    if (ctx.deltas.some((delta) => delta.t === "page"))
      throw new Refusal("invalid");
    if (cmd.name === "journal.savePage") {
      if (!isDocumentStamp(cmd.args.stamp)) throw new Refusal("invalid");
      const current = ctx.stored("page", cmd.args.day);
      if (
        current &&
        compareDocumentStamps(cmd.args.stamp, current.f.documentStamp[0]) <= 0
      )
        return { deltas: [], write: [] };
      return this.replace(ctx, cmd.args);
    }
    if (cmd.name !== "journal.claimPage") throw new Refusal("invalid");
    const claims = book(ctx, "journalClaims");
    const digest = createHash("sha256").update(jcs(cmd.args)).digest("hex");
    const old = ownValue(claims, cmd.args.claimId);
    if (old) {
      if (old.digest !== digest) throw new Refusal("claim-conflict");
      return { deltas: [], write: [] };
    }
    const current = ctx.stored("page", cmd.args.day);
    const body = claimBody(current?.x.body.text ?? "", cmd.args.body);
    checkedBody(body);
    const clocks = book(ctx, "journalContentClocks");
    const stamp = nextDocumentStamp({
      pair: clocks.server,
      observed: current?.f.documentStamp[0],
      now: ctx.serverNow,
      actor: "srv",
    });
    clocks.server = { ms: stamp.ms, counter: stamp.counter };
    const args = {
      ...cmd.args,
      body,
      mood: cmd.args.mood ?? current?.f.mood[0] ?? null,
      energy: cmd.args.energy ?? current?.f.energy[0] ?? null,
      stamp,
    };
    const outcome = this.replace(ctx, args);
    setOwn(claims, cmd.args.claimId, {
      digest,
      day: cmd.args.day,
      documentStamp: stamp,
    });
    return outcome;
  }

  replace(ctx, args) {
    const current = ctx.stored("page", args.day);
    book(ctx, "journalPages")[args.day] = { updatedAt: ctx.serverNow };
    const names = ["mood", "energy", "source"];
    const f = Object.fromEntries(
      names.map((name) => [name, [args[name], null]]),
    );
    f.documentStamp = [args.stamp, null];
    const archive = {
      archivedAt: ctx.serverNow,
      documentStamp: current?.f.documentStamp[0],
    };
    if (archive.documentStamp === undefined) delete archive.documentStamp;
    return {
      deltas: [
        {
          t: "page",
          id: args.day,
          f,
          x: {
            body: replacementText(args.body, {
              archiveNonempty: true,
              archive,
            }),
          },
        },
      ],
      write: [
        {
          t: "page",
          id: args.day,
          f: Object.fromEntries(Object.keys(f).map((name) => [name, null])),
        },
      ],
    };
  }

  check(ctx) {
    if (ctx.deltas.some((delta) => delta.t === "page"))
      throw new Refusal("invalid");
    return [];
  }

  // The per-day bound runs only for days archived by this admission, then account-wide bounds.
  pruneRevisions(ctx) {
    const affected = new Set(
      ctx.archived
        .filter((row) => row.t === "page" && row.field === "body")
        .map((row) => row.id),
    );
    const newest = [...ctx.revisions].sort(
      (a, b) => b.archivedAt - a.archivedAt || b.rev - a.rev,
    );
    const perDay = {};
    const daily = newest.filter(
      (row) =>
        !affected.has(row.id) ||
        (perDay[row.id] = (perDay[row.id] ?? 0) + 1) <= 10,
    );
    let bytes = 0;
    const kept = daily.filter((row, index) => {
      bytes += Buffer.byteLength(row.text, "utf8");
      return (
        index < 500 &&
        bytes <= 8388608 &&
        row.archivedAt >= ctx.serverNow - RETENTION_MS
      );
    });
    const projection =
      ctx.productState.journalRevisionProjection?.[ctx.scopeKey];
    if (projection)
      for (const rev of Object.keys(projection))
        if (!kept.some((row) => String(row.rev) === rev))
          delete projection[rev];
    return kept;
  }
}
