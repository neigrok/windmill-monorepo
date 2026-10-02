// Appendix D: frozen journal tables adopted in place, with an explicit adoption manifest.

import { createHash } from "node:crypto";
import { replaceRow } from "../core/digest.js";
import { jcs } from "../core/jcs.js";
import { compareRecords, stampsOf } from "../core/rows.js";
import { ServerState } from "../server/state.js";
import {
  isCalendarDay,
  isDocumentStamp,
  JOURNAL_STATE_FIELDS,
} from "./product.js";

const FIRST_RUN_POLICY = "retire-existing";

export function backfill({
  state,
  registry,
  account,
  legacy,
  M,
  firstRunPolicy = FIRST_RUN_POLICY,
}) {
  if (firstRunPolicy !== FIRST_RUN_POLICY)
    throw new Error("journal first-run migration policy must be retire-existing");
  const key = `acct:${account}/journal`;
  const next = state.clone();
  const manifest = createHash("sha256").update(jcs(legacy)).digest("hex");
  const adopted = next.product.journalAdoptions?.[key];
  if (adopted) {
    if (
      adopted.manifest !== manifest ||
      adopted.M !== M ||
      adopted.firstRunPolicy !== firstRunPolicy
    )
      throw new Error("journal adoption manifest differs");
    return next;
  }
  if (next.scope(key))
    throw new Error("journal scope exists without an adoption marker");
  if (!Number.isSafeInteger(M) || M < 0 || M >= 2 ** 53)
    throw new Error("invalid migration instant");
  const pages = structuredClone(legacy.pages ?? []).sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );
  const revisions = structuredClone(legacy.revisions ?? []).sort(
    (a, b) => a.migrationId - b.migrationId,
  );
  if (!pages.length && !revisions.length) return next;
  const days = new Set();
  const validPage = (row) => {
    if (
      !isCalendarDay(row.day) ||
      !isDocumentStamp(row.stamp) ||
      typeof row.body !== "string"
    )
      throw new Error("invalid legacy journal row");
  };
  for (const page of pages) {
    validPage(page);
    if (days.has(page.day)) throw new Error("duplicate legacy page day");
    days.add(page.day);
    for (const name of ["mood", "energy"])
      if (!Number.isInteger(page[name]) || page[name] < 0 || page[name] > 10)
        page[name] = null;
    page.source = page.source === "spoken" ? "spoken" : "typed";
  }
  const ids = new Set();
  for (const revision of revisions) {
    validPage(revision);
    if (
      !Number.isSafeInteger(revision.migrationId) ||
      revision.migrationId < 1 ||
      ids.has(revision.migrationId)
    )
      throw new Error("invalid frozen revision identity");
    ids.add(revision.migrationId);
  }
  const scope = next.insertScope(key, { kind: "product", owner: account });
  const stamp = `${M}:0:srv`;
  const projections = {};
  let seq = 0;
  // Old audit rows have no primary key: migrationId is the immutable frozen-scan manifest ordinal.
  for (const revision of revisions) {
    const rev = ++seq;
    next.keepRevision(
      key,
      {
        t: "page",
        id: revision.day,
        field: "body",
        rev,
        text: revision.body,
        archivedAt: revision.supersededAt,
        documentStamp: revision.stamp,
      },
      Infinity,
    );
    projections[String(rev)] = {
      migrationId: revision.migrationId,
      stamp: revision.stamp,
      supersededAt: revision.supersededAt,
    };
  }
  const pageProjections = {};
  for (const page of pages) {
    const f = Object.fromEntries(
      ["mood", "energy", "source"].map((name) => [name, [page[name], stamp]]),
    );
    f.documentStamp = [page.stamp, stamp];
    const row = {
      t: "page",
      id: page.day,
      f,
      x: { body: { text: page.body, rev: ++seq, merged: false } },
      seq,
      rc: page.updatedAt,
      ru: page.updatedAt,
    };
    next.putRow(key, row);
    scope.digest = replaceRow(
      scope.digest,
      undefined,
      next.row(key, row.t, row.id),
    );
    pageProjections[page.day] = { updatedAt: page.updatedAt };
  }
  if (
    pages.some(
      (page) => page.body !== "" || page.mood !== null || page.energy !== null,
    )
  ) {
    const row = {
      t: "journalState",
      id: "journalState",
      f: Object.fromEntries(
        JOURNAL_STATE_FIELDS.map((name) => [
          name,
          ["retired", stamp],
        ]),
      ),
      seq: ++seq,
      rc: M,
      ru: M,
    };
    next.putRow(key, row);
    scope.digest = replaceRow(
      scope.digest,
      undefined,
      next.row(key, row.t, row.id),
    );
  }
  scope.seq = seq;
  (next.product.journalAdoptions ??= {})[key] = { M, manifest, firstRunPolicy };
  if (Object.keys(projections).length)
    (next.product.journalRevisionProjection ??= {})[key] = projections;
  if (Object.keys(pageProjections).length)
    (next.product.journalPages ??= {})[key] = pageProjections;
  return new ServerState(next.toJSON());
}

// D.8's audit reads the frozen input and recorded M, never a writer-generated expected state.
export function audit({ state, account, legacy, M, firstRunPolicy = FIRST_RUN_POLICY }) {
  if (firstRunPolicy !== FIRST_RUN_POLICY)
    throw new Error("journal adoption audit: first-run policy must be retire-existing");
  const key = `acct:${account}/journal`;
  const check = (label, actual, expected) => {
    if (jcs({ value: actual }) !== jcs({ value: expected }))
      throw new Error(`journal adoption audit: ${label}`);
  };
  const pages = [...(legacy.pages ?? [])].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );
  const revisions = [...(legacy.revisions ?? [])].sort(
    (a, b) => a.migrationId - b.migrationId,
  );
  const normalizedScale = (value) =>
    Number.isInteger(value) && value >= 0 && value <= 10 ? value : null;
  const written = pages.some(
    (page) =>
      page.body !== "" ||
      normalizedScale(page.mood) !== null ||
      normalizedScale(page.energy) !== null,
  );
  const roster = pages.map((page) => ({ t: "page", id: page.day }));
  if (written) roster.push({ t: "journalState", id: "journalState" });
  check(
    "frozen row identities",
    state.rowsOf(key).map(({ t, id }) => ({ t, id })).sort(compareRecords),
    roster.sort(compareRecords),
  );
  check("spent ids", state.spentOf(key), []);
  if (!pages.length && !revisions.length) {
    check("empty account scope", state.scope(key), undefined);
    return true;
  }
  const stamp = `${M}:0:srv`;
  check("recorded adoption", state.product.journalAdoptions?.[key], {
    M,
    manifest: createHash("sha256").update(jcs(legacy)).digest("hex"),
    firstRunPolicy,
  });
  for (const row of state.rowsOf(key)) {
    for (const envelope of stampsOf(row))
      check(`${row.t}/${row.id} envelope`, envelope, stamp);
    check(`${row.t}/${row.id} life`, row.life, undefined);
    check(`${row.t}/${row.id} born`, row.born, undefined);
  }
  for (const [index, page] of pages.entries()) {
    const row = state.row(key, "page", page.day);
    const seq = revisions.length + index + 1;
    check(`${page.day} registers`, row.f, {
      mood: [normalizedScale(page.mood), stamp],
      energy: [normalizedScale(page.energy), stamp],
      source: [page.source === "spoken" ? "spoken" : "typed", stamp],
      documentStamp: [page.stamp, stamp],
    });
    check(`${page.day} head revision`, row.x, {
      body: { text: page.body, rev: seq, merged: false },
    });
    check(`${page.day} seq`, row.seq, seq);
    check(`${page.day} rc`, row.rc, page.updatedAt);
    check(`${page.day} ru`, row.ru, page.updatedAt);
  }
  if (written) {
    const row = state.row(key, "journalState", "journalState");
    check(
      "first-run registers",
      row.f,
      Object.fromEntries(JOURNAL_STATE_FIELDS.map((name) => [
        name,
        ["retired", stamp],
      ])),
    );
    check("first-run seq", row.seq, revisions.length + pages.length + 1);
    check("first-run rc", row.rc, M);
    check("first-run ru", row.ru, M);
  }
  check(
    "frozen historical revisions",
    [...(state.revisions[key] ?? [])].sort((a, b) => a.rev - b.rev),
    revisions.map((revision, index) => ({
      t: "page", id: revision.day, field: "body", rev: index + 1,
      text: revision.body, archivedAt: revision.supersededAt,
      documentStamp: revision.stamp,
    })),
  );
  check("page receipt projections", state.product.journalPages?.[key] ?? {},
    Object.fromEntries(pages.map((page) => [page.day, { updatedAt: page.updatedAt }])));
  check("revision receipt projections", state.product.journalRevisionProjection?.[key] ?? {},
    Object.fromEntries(revisions.map((revision, index) => [String(index + 1), {
      migrationId: revision.migrationId, stamp: revision.stamp, supersededAt: revision.supersededAt,
    }])));
  check("claim receipts", state.product.journalClaims?.[key] ?? {}, {});
  check("scope seq", state.scope(key)?.seq, revisions.length + pages.length + Number(written));
  check("scope counters", state.scope(key)?.counters, {});
  return true;
}
