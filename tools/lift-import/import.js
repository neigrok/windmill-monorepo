#!/usr/bin/env node
// lift-import — carry the author's real training history out of Lift and into the Windmill gym log.
//
//   node tools/lift-import/import.js --export lift-export.json --token <session> [--dry-run]
//
// One-shot, re-runnable, and it adds no backend surface: every write goes through the public API
// with an id derived from the Lift UUID, so a second run replays onto the same rows and changes
// nothing. Read the README beside this file for the why.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GymClient, GymRefusal } from './client.js';
import {
  ImportRefusal,
  distinctExerciseNames,
  nearestMovements,
  buildCatalogIndex,
  normalizeName,
  planSessions,
  readExport,
  resolveNames,
} from './plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `lift-import — Lift's training history into the Windmill gym log

  node tools/lift-import/import.js --export <file> [options]

  --export <file>    the Lift export json (required)
  --base-url <url>   the Windmill API (default $WINDMILL_BASE_URL or http://localhost:8080)
  --token <secret>   a session credential (default $WINDMILL_TOKEN)
  --mapping <file>   the exercise-name mapping (default tools/lift-import/mapping.json)
  --dry-run          resolve names, print the whole summary, write nothing anywhere
  --help
`;

export function parseArgs(argv) {
  const args = {
    exportPath: null,
    baseUrl: process.env.WINDMILL_BASE_URL ?? 'http://localhost:8080',
    token: process.env.WINDMILL_TOKEN ?? '',
    mappingPath: resolvePath(HERE, 'mapping.json'),
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--export') args.exportPath = argv[++i];
    else if (flag === '--base-url') args.baseUrl = argv[++i];
    else if (flag === '--token') args.token = argv[++i];
    else if (flag === '--mapping') args.mappingPath = argv[++i];
    else if (!flag.startsWith('-') && !args.exportPath) args.exportPath = flag;
    else throw new ImportRefusal(`unknown argument: ${flag}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.exportPath) throw new ImportRefusal('--export <file> is required (--help for the rest)');
  if (!args.token) throw new ImportRefusal('--token <secret>, or $WINDMILL_TOKEN, is required');

  const document = readExport(await readFile(resolvePath(process.cwd(), args.exportPath), 'utf8'));
  const overrides = await readMapping(args.mappingPath);
  const client = new GymClient({ baseUrl: args.baseUrl, token: args.token });

  const catalog = await client.exercises();
  if (catalog.length === 0) throw new ImportRefusal('the catalog came back empty — wrong server, or the seed never ran');
  const { resolved, unresolved } = resolveNames(distinctExerciseNames(document), catalog, overrides);

  // The one decision the whole corpus's integrity rests on, and the tool does not take it. An
  // unmatched or ambiguous name stops the run with nothing written, hands the human a file with the
  // candidates that were considered, and honors what they write there on the next pass.
  if (unresolved.length > 0) {
    const mapping = mappingDocument(document, catalog, resolved, unresolved, overrides);
    if (!args.dryRun) await writeFile(args.mappingPath, `${JSON.stringify(mapping, null, 2)}\n`);
    reportUnresolved(unresolved, args, mapping);
    return 2;
  }

  const plan = planSessions(document, resolved);
  reportPlan(plan, resolved, args);

  if (args.dryRun) {
    process.stdout.write('\ndry run — nothing was written, to the log or to disk.\n');
    return 0;
  }

  const written = await writeCorpus(client, plan.sessions);
  reportWritten(written);
  await writeFile(args.mappingPath, `${JSON.stringify(mappingDocument(document, catalog, resolved, [], overrides), null, 2)}\n`);
  return written.failures.length > 0 ? 1 : 0;
}

async function readMapping(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (failure) {
    throw new ImportRefusal(`${path} is not readable json: ${failure.message}`);
  }
  // A hand-written file with the map at the top level would silently resolve nothing, and the run
  // would stop on names the human believes they already mapped. Say so instead.
  if (typeof parsed?.exercises !== 'object' || parsed.exercises === null)
    throw new ImportRefusal(`${path} has no "exercises" object — that is where the names are mapped`);
  return parsed.exercises;
}

function mappingDocument(document, catalog, resolved, unresolved, overrides) {
  const index = buildCatalogIndex(catalog);
  const stillOpen = new Set(unresolved.map((one) => one.name));
  const exercises = {};
  const candidates = {};
  for (const name of distinctExerciseNames(document)) {
    // A human's mapping is kept even when the catalog cannot honor it — retyping a corrected id
    // beats retyping the whole line — and it keeps its candidate list until it resolves.
    exercises[name] = resolved.get(name) ?? overrides[name] ?? null;
    if (exercises[name] === null || stillOpen.has(name))
      candidates[name] = nearestMovements(normalizeName(name), index);
  }
  return {
    note: 'Every Lift exercise name, folded onto a Windmill catalog id. A null is a name the import '
      + 'refused to guess at — put a catalog id there (the candidates below are what was considered, '
      + 'and GET /v1/gym/exercises is the full list) and run the import again.',
    generatedAt: Date.now(),
    unresolved: unresolved.map(({ name, reason }) => ({ name, reason })),
    exercises,
    candidates,
  };
}

// Per session: start it, append its sets in completedAt order, then close it. The order is the
// contract — a set must be appended while the session is open, because appending a NEW set to a
// finished session is refused 409 by design.
async function writeCorpus(client, sessions) {
  const written = { sessions: 0, sets: 0, setsReplayed: 0, sessionsReplayed: 0, failures: [] };
  for (const session of sessions) {
    let started;
    try {
      started = await client.startSession(session.id, session.startedAt);
    } catch (failure) {
      written.failures.push({ label: session.label, at: 'start', reason: describe(failure), lostSets: session.sets.length });
      continue;
    }
    // A start while another session is open JOINS the open one — so a reply naming a different
    // session means this account has a workout in progress, and every set here would land in it.
    // That is a corpus-corrupting write, so the run stops rather than guesses.
    if (started?.id !== session.id)
      throw new ImportRefusal(
        `the account has an open session (${started?.id}) — starting an import session joined it instead.\n`
        + `Finish it first: POST /v1/gym/sessions/${started?.id}/finish {"finishedAt": <epoch-ms>}`);
    if (started.finishedAt) written.sessionsReplayed += 1;

    for (const set of session.sets) {
      try {
        const stored = await client.appendSet(session.id, set);
        if (stored?.id === set.id) written.sets += 1;
        if (started.finishedAt) written.setsReplayed += 1;
      } catch (failure) {
        written.failures.push({ label: `${session.label} · ${set.exerciseId}`, at: 'set', reason: describe(failure), lostSets: 1 });
      }
    }

    try {
      await client.finishSession(session.id, session.finishedAt);
      written.sessions += 1;
    } catch (failure) {
      written.failures.push({ label: session.label, at: 'finish', reason: describe(failure), lostSets: 0 });
    }
  }
  return written;
}

function describe(failure) {
  if (failure instanceof GymRefusal) return `${failure.status} ${failure.code ?? '—'} ${failure.sentence}`;
  return failure.message;
}

function reportUnresolved(unresolved, args, mapping) {
  process.stdout.write(`\n${unresolved.length} exercise name${unresolved.length === 1 ? '' : 's'} could not be resolved. Nothing was written.\n\n`);
  for (const { name, reason, candidates } of unresolved) {
    process.stdout.write(`  "${name}" — ${reason}\n`);
    if (candidates.length === 0) process.stdout.write('      no candidates worth showing\n');
    for (const candidate of candidates) process.stdout.write(`      ${candidate.id.padEnd(28)} ${candidate.name}\n`);
  }
  if (args.dryRun) {
    process.stdout.write('\ndry run — this is the mapping that would have been written:\n\n');
    process.stdout.write(`${JSON.stringify(mapping, null, 2)}\n`);
    return;
  }
  process.stdout.write(`\nEdit ${args.mappingPath} — put a catalog id beside each name above — and run this again.\n`);
}

function reportPlan(plan, resolved, args) {
  const { counts, skips } = plan;
  process.stdout.write(`\n${args.dryRun ? 'dry run — ' : ''}the plan\n`);
  process.stdout.write(`  ${resolved.size} distinct exercise names, all folded onto catalog ids\n`);
  process.stdout.write(`  ${counts.sessionsPlanned} of ${counts.sessionsTotal} sessions · ${counts.setsPlanned} of ${counts.setsTotal} sets\n`);

  const refusals = [
    ['sessions with no sets (an accidental Finish)', counts.sessionsSkippedNoSets],
    ['sessions whose every set was refused', counts.sessionsSkippedEverySetRefused],
    ['sessions unreadable (bad id or start instant)', counts.sessionsSkippedUnreadable],
    ['sessions holding a duplicate id', counts.sessionsSkippedDuplicateId],
    ['sets unreadable (bad id)', counts.setsSkippedUnreadable],
    ['sets holding a duplicate id', counts.setsSkippedDuplicateId],
    ['sets naming an unresolved movement', counts.setsSkippedUnresolvedName],
    ['sets with reps outside 1..500', counts.setsSkippedRepsOutOfBand],
    ['sets with weight outside -500..500', counts.setsSkippedWeightOutOfBand],
    ['sets with an instant outside the band', counts.setsSkippedInstantOutOfBand],
  ].filter(([, count]) => count > 0);

  process.stdout.write('\nrefused\n');
  if (refusals.length === 0) process.stdout.write('  nothing — every row in the export is storable\n');
  for (const [label, count] of refusals) process.stdout.write(`  ${String(count).padStart(5)}  ${label}\n`);

  process.stdout.write('\nrepaired\n');
  process.stdout.write(`  ${String(counts.sessionsFinishedFromLastSet).padStart(5)}  abandoned sessions closed at their last set\n`);
  process.stdout.write(`  ${String(counts.sessionsFinishRepaired).padStart(5)}  sessions whose finish instant could not close them, closed at their last set\n`);
  process.stdout.write(`  ${String(counts.setsWeightRounded).padStart(5)}  weights that will round to two decimals in the store\n`);

  if (skips.length === 0) return;
  process.stdout.write(`\nevery row refused or repaired, one by one (${skips.length})\n`);
  for (const skip of skips.slice(0, 40))
    process.stdout.write(`  ${skip.scope === 'session' ? 'session' : 'set    '}  ${skip.label} — ${skip.reason}`
      + `${skip.lostSets > 0 ? ` (${skip.lostSets} sets go with it)` : ''}\n`);
  if (skips.length > 40) process.stdout.write(`  … and ${skips.length - 40} more\n`);
}

function reportWritten(written) {
  process.stdout.write('\nwritten\n');
  process.stdout.write(`  ${written.sessions} sessions closed · ${written.sets} sets present in the log\n`);
  if (written.sessionsReplayed > 0)
    process.stdout.write(`  ${written.sessionsReplayed} of those sessions were already there — ${written.setsReplayed} sets replayed onto their stored rows\n`);
  if (written.failures.length === 0) {
    process.stdout.write('  nothing was lost\n');
    return;
  }
  process.stdout.write(`\n${written.failures.length} write${written.failures.length === 1 ? '' : 's'} the server refused\n`);
  for (const failure of written.failures)
    process.stdout.write(`  ${failure.at.padEnd(6)}  ${failure.label} — ${failure.reason}`
      + `${failure.lostSets > 0 ? ` (${failure.lostSets} sets not written)` : ''}\n`);
}

// Run only when this file IS the command — so the arg parsing above stays importable by a test
// without the import firing as a side effect of loading it.
if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
    .then((code) => process.exit(code))
    .catch((failure) => {
      process.stderr.write(`\n${failure instanceof ImportRefusal ? failure.message : (failure.stack ?? String(failure))}\n`);
      process.exit(1);
    });
