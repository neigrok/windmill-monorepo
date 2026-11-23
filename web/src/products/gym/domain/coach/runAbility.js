// @ts-check
// The replica executor (Coach engine D-6, gym Coach on the AI service §4.2): one ability call of a turn, run on this
// browser's replica as one gesture that re-checks the call's shape and bounds, commits the ability's writes and records
// the call on the Coach message, or, when the call is refused, records the refusal alone.

import { seededId } from '../../../../../../packages/api-contract/sync/reference/core/derive.js';
import { jcsBytes } from '../../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { sha256 } from '../../../../../../packages/api-contract/sync/reference/core/sha256.js';
import { JsonSchema } from '../../../../platform/domain-kit/abilities.js';
import { Decision, decision } from '../../../../platform/domain-kit/actions.js';
import { DecodeError, Fields, Id, sameJson } from '../../../../platform/domain-kit/entities.js';
import { Plan } from '../../../../platform/domain-kit/plans.js';
import { Refused } from '../../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../../platform/domain-kit/validation.js';
import { Path, Violation, firstNul } from '../../../../platform/domain-kit/values.js';
import { registry } from '../../../../platform/sync/schema.js';
import { Exercise, ExerciseValue, defaultStepKg } from '../catalogue.js';
import { GymRefusals, RoutineRules } from '../gymRules.js';
import { Note, NoteRules, NoteValue } from '../notes.js';
import { ProposeRoutine, Proposal } from '../proposals.js';
import { Routine, RoutineEntry, RoutineValue } from '../routines.js';
import { Session, SessionRules } from '../training.js';
import { ProposeWorkout, WorkoutProposal } from '../workoutProposals.js';
import { BodyweightRead, CatalogueRead, LogRead, NotesRead, ProgramRead } from './abilityReads.js';
import { CreateExerciseCall, CreateRoutineCall, ProposeRoutineCall, ProposeWorkoutCall, SaveNoteAbility } from './abilityWrites.js';
import { AbilityCall, AbilityRefusals, CoachMessage, CoachRules } from './conversation.js';
import { writersOwn } from './turn.js';

/** @typedef {import('../../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../../platform/domain-kit/actions.js').IDSource} IDSource */
/** @typedef {import('../../../../platform/domain-kit/abilities.js').Catalog} Catalog */
/** @typedef {import('../gymRules.js').GymRefusal} GymRefusal */
/** @typedef {import('./conversation.js').CoachMessageValue} CoachMessageValue */
/** @typedef {import('./abilityReads.js').AbilityAnswer} AbilityAnswer */
/** @typedef {'bound' | 'anon'} Seat */
/** @typedef {import('../../../../platform/domain-kit/actions.js').Decider<any, AbilityAnswer, GymRefusal>} AbilityDecider */
/** @typedef {{ kind: 'result', jcs: Uint8Array, sha256: string } | { kind: 'refused', code: string }} AbilityOutcome */

// One call as the model made it: its id, the ability's name and the input, in the model's own words.
export class AbilityRequest {
  /** @param {string} callId @param {string} name @param {Json} input */
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
    Object.freeze(this);
  }

  // gym Coach G-7: the abilities that create a record, and the type each creates. The turn names the record, never the
  // model (`RunAbility.ordinal`).
  static creates = Object.freeze(/** @type {Record<string, string>} */ ({ create_routine: Routine.type, create_exercise: Exercise.type,
    save_note: Note.type, propose_routine_change: Proposal.type, propose_routine_removal: Proposal.type, propose_workout_change: WorkoutProposal.type }));

  /** @param {Json} input */
  with(input) { return new AbilityRequest(this.callId, this.name, input); }
}

// The bounds a provider's strict mode cannot state (gym Coach on the AI service §3, R-11), held by each ability's rule
// and refused `invalid-arguments` before any rule reads the store: the shapes `catalog/2` stated, in its own words.
const lineBounds = { maxItems: 50, items: { properties: {
  restSeconds: { minimum: 15, maximum: 900 }, sets: { maxItems: 20, items: { properties: { reps: { minimum: 1, maximum: 100 } } } } } } };
const idListBounds = { maxItems: 50, uniqueItems: true, items: { maxLength: 128 } };
const ArgumentBounds = Object.freeze(/** @type {Record<string, JsonSchema>} */ ({
  list_sessions: new JsonSchema({ properties: { before: { minimum: 1, maximum: SessionRules.maxInstantMs }, limit: { minimum: 1, maximum: LogRead.maxPage } } }),
  get_sessions: new JsonSchema({ properties: { sessionIds: idListBounds } }),
  get_last_times: new JsonSchema({ properties: { exerciseIds: idListBounds } }),
  create_exercise: new JsonSchema({ properties: { name: { maxLength: 240 } } }),
  create_routine: new JsonSchema({ properties: { entries: lineBounds, name: { maxLength: 240 }, position: { minimum: RoutineRules.position.min, maximum: RoutineRules.position.max } } }),
  propose_routine_change: new JsonSchema({ properties: { entries: lineBounds, name: { maxLength: 240 }, summary: { maxLength: 400 } } }),
  propose_routine_removal: new JsonSchema({ properties: { summary: { maxLength: 400 } } }),
  propose_workout_change: new JsonSchema({ properties: { entries: lineBounds, summary: { maxLength: 400 } } }),
}));

// Shares are server records: the host calls the Share door for them, and never sends one here (§4.3).
export const SERVER_RUN = Object.freeze(['share_session', 'share_log', 'revoke_share']);

/** @param {Json} value @returns {number} */
function depth(value) {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (value !== null && typeof value === 'object') return 1 + Math.max(0, ...Object.values(value).map(depth));
  return 0;
}

// gym Coach G-7, kit §4 "given": the id the turn minted for the call's new record, in the shape the registry admits.
/** @template E @param {Fields} f @param {import('../../../../platform/domain-kit/entities.js').EntityType<E>} type @returns {Id<E>} */
function given(f, type) {
  const id = f.string('id');
  if (!new RegExp(registry.type(type.type).idPattern, 'u').test(id)) throw new DecodeError(type.type, 'id', 'not an id the registry admits');
  return new Id(id, type);
}

/** @template E @param {Fields} f @param {string} field @param {import('../../../../platform/domain-kit/entities.js').EntityType<E>} type */
function idsIn(f, field, type) {
  const items = f.present(field);
  if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) throw new DecodeError(type.type, field, 'not a list of ids');
  return items.map((item) => new Id(/** @type {string} */ (item), type));
}

/** @param {AbilityRequest} request @param {string} appBaseUrl @returns {AbilityDecider} */
function deciderOf(request, appBaseUrl) {
  const f = Fields.object(request.input, request.name);
  switch (request.name) {
    case 'list_routines': return new ProgramRead(f.optionalRef('routineId', Routine));
    case 'list_exercises': return new CatalogueRead();
    case 'list_sessions': {
      const beforeId = f.optionalString('beforeId');
      if (beforeId !== null && f.isAbsent('before')) throw new DecodeError('list_sessions', 'beforeId', 'without before');
      return new LogRead({ kind: 'sessions', before: f.optionalInstant('before')?.ms ?? SessionRules.maxInstantMs, beforeId: beforeId ?? '',
        limit: Math.min(LogRead.maxPage, f.optionalInt('limit') ?? LogRead.defaultPage) });
    }
    case 'get_session': return new LogRead({ kind: 'workout', id: f.ref('sessionId', Session), review: f.bool('review', false) });
    case 'get_sessions': return new LogRead({ kind: 'workouts', ids: idsIn(f, 'sessionIds', Session), review: f.bool('review', false) });
    case 'last_time': return new LogRead({ kind: 'lastTime', id: f.ref('exerciseId', Exercise) });
    case 'get_last_times': return new LogRead({ kind: 'lastTimes', ids: idsIn(f, 'exerciseIds', Exercise) });
    case 'get_stats': return new LogRead({ kind: 'stats', only: f.optionalRef('exerciseId', Exercise) });
    case 'list_notes': return new NotesRead();
    case 'list_bodyweight': return new BodyweightRead(f.optionalString('from'), f.optionalString('to'));
    case 'create_routine': return new CreateRoutineCall(new RoutineValue(given(f, Routine), f.string('name'), f.int('position'), f.list('entries', RoutineEntry.decode)));
    case 'create_exercise': {
      const equipment = f.string('equipment');
      return new CreateExerciseCall(new ExerciseValue(given(f, Exercise), f.string('name'), f.string('pattern'), equipment,
        f.optionalDouble('stepKg') ?? defaultStepKg(equipment)));
    }
    case 'save_note': {
      // The server's note bounds (backend Note.cpp, its tool's `invalid-arguments`): a blank title, a title past 60 code
      // points or a body past 500 UTF-8 bytes, measured after the trim. What the store refuses beyond them stays `refused`.
      const note = new NoteValue(given(f, Note), f.string('title'), f.string('body'));
      try {
        NoteRules.title.apply(note.title, new Path('title'));
        NoteRules.body.apply(note.body, new Path('body'));
      } catch (error) {
        if (error instanceof Violation) throw new DecodeError(Note.type, error.path.text, 'past the note\'s bounds');
        throw error;
      }
      return new SaveNoteAbility(note);
    }
    case 'propose_routine_change': return new ProposeRoutineCall(ProposeRoutine({ id: given(f, Proposal), routineId: f.ref('routineId', Routine),
      name: f.optionalString('name'), entries: f.list('entries', RoutineEntry.decode), summary: f.string('summary', '') }), appBaseUrl);
    case 'propose_routine_removal': return new ProposeRoutineCall(ProposeRoutine({ id: given(f, Proposal), routineId: f.ref('routineId', Routine),
      name: null, entries: [], summary: f.string('summary', ''), removing: true }), appBaseUrl);
    case 'propose_workout_change': return new ProposeWorkoutCall(ProposeWorkout({ id: given(f, WorkoutProposal), sessionId: f.ref('sessionId', Session),
      entries: f.list('entries', RoutineEntry.decode), summary: f.string('summary', '') }));
    default: throw new DecodeError(request.name, 'name', 'no replica ability');
  }
}

// The call's outcome, committed with its record on the Coach message. A refusal of the action itself means the message
// is not this replica's Coach message while its writer answers it, so nothing was recorded and the turn is over.
export class RunAbility {
  scope = CoachMessage.scope;
  refusals = GymRefusals;

  // The codes of a call the gate refuses before it admits it (G-1 to G-3): such a call mints no ordinal and holds no slot.
  static notAdmitted = /** @type {readonly string[]} */ (Object.freeze([AbilityRefusals.notOffered, AbilityRefusals.seatRequired, AbilityRefusals.invalidInput]));

  /** @param {AbilityCall} call */
  static admitted(call) { return !RunAbility.notAdmitted.includes(call.outcome); }

  /** @param {AbilityRequest} request @param {Id<CoachMessageValue>} message @param {Seat} seat @param {Catalog} catalog @param {string} appBaseUrl */
  constructor(request, message, seat, catalog, appBaseUrl) {
    this.request = request;
    this.message = message;
    this.appBaseUrl = appBaseUrl;
    this.admission = RunAbility.admit(request, seat, catalog);
  }

  // gym Coach §5 on the device: G-1 offered, G-2 the seat, the server's own abilities, G-3 the shape at every depth.
  /** @param {AbilityRequest} request @param {Seat} seat @param {Catalog} catalog @returns {string | null} the code it refuses with */
  static admit(request, seat, catalog) {
    const ability = catalog.ability(request.name);
    if (ability === null || ability.agent === 'withheld' || !ability.declared || SERVER_RUN.includes(request.name)) return AbilityRefusals.notOffered;
    if (!ability.admits(seat)) return AbilityRefusals.seatRequired;
    if (new JsonSchema(ability.input).fault(request.input) !== null) return AbilityRefusals.invalidInput;
    return null;
  }

  // gym Coach G-7, as the server's gate seeds: every admitted call that mints a record takes the next turn-wide ordinal,
  // whatever its outcome, so a call refused by its rule still holds its number. A call run again under its `callId` keeps
  // the place an admitted first run holds, and with it its ordinal; one whose first run the gate refused takes the next.
  /** @param {CoachMessageValue} turn @param {string} callId */
  static ordinal(turn, callId) {
    const slot = turn.calls.findIndex((call) => call.callId === callId && RunAbility.admitted(call));
    const before = slot < 0 ? turn.calls.filter((call) => call.callId !== callId) : turn.calls.slice(0, slot);
    return 1 + before.filter((call) => AbilityRequest.creates[call.name] !== undefined && RunAbility.admitted(call)).length;
  }

  // The admitted call's input as the ability reads it: the record it mints named from the turn, then the bounds the schema
  // cannot state, the depth a record can hold, and the ability's decider from that input.
  /** @param {AbilityRequest} request @param {CoachMessageValue} turn @returns {{ request: AbilityRequest, refuse: string } | { request: AbilityRequest, run: AbilityDecider }} */
  gate(request, turn) {
    const type = AbilityRequest.creates[request.name];
    const input = /** @type {Record<string, Json>} */ (request.input);
    const seeded = type === undefined ? request
      : request.with({ ...input, id: seededId(registry.type(type), String(turn.id.record), RunAbility.ordinal(turn, request.callId)) });
    if (ArgumentBounds[seeded.name]?.fault(seeded.input) || depth(seeded.input) > CoachRules.maxInputDepth) return { request: seeded, refuse: AbilityRefusals.invalidArguments };
    try { return { request: seeded, run: deciderOf(seeded, this.appBaseUrl) }; }
    catch (error) {
      if (error instanceof DecodeError) return { request: seeded, refuse: AbilityRefusals.invalidArguments };
      throw error;
    }
  }

  /** @param {Reader} read */
  load(read) {
    const coach = read.repository(CoachMessage).find(this.message, 'drawn');
    const own = coach !== null && writersOwn(coach, read.replica);
    const gate = own && this.admission === null ? this.gate(this.request, /** @type {CoachMessageValue} */ (coach)) : null;
    return { message: coach, own, gate, deciding: gate !== null && 'run' in gate ? gate.run.load(read) : null, moment: read.moment };
  }

  /** @param {ReturnType<RunAbility['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const coach = loaded.message?.isCoach ? loaded.message : null;
    if (coach === null) return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', this.message.ref, null, 'predicted')));
    if (!loaded.own) return Decision.refuse(GymRefusals.ofRefused(new Refused('message-final', this.message.ref, null, 'predicted')));
    const gate = loaded.gate;
    if (gate === null) return this.refusing(this.request, /** @type {string} */ (this.admission), null, coach, loaded.moment);
    if ('refuse' in gate) return this.refusing(gate.request, gate.refuse, gate.request.input, coach, loaded.moment);
    const decided = decision(gate.run, loaded.deciding, ids);
    if (decided.kind === 'refuse') {
      const refusal = decided.refusal;
      const code = refusal.kind === 'invalid' && refusal.violation.rule === RoutineRules.loadFloor ? AbilityRefusals.loadFloor : AbilityRefusals.refused;
      return this.refusing(gate.request, code, gate.request.input, coach, loaded.moment);
    }
    return this.answering(gate.request, decided.result, decided.kind === 'write' ? decided.plan : new Plan(), coach, loaded.moment);
  }

  /** @param {AbilityRequest} request @param {string} code @param {Json | null} input @param {CoachMessageValue} coach @param {import('../../../../platform/domain-kit/time.js').Moment} moment */
  refusing(request, code, input, coach, moment) {
    return this.recording(new AbilityCall({ callId: request.callId, name: request.name, input, outcome: code }), { kind: 'refused', code }, new Plan(), coach, moment);
  }

  // gym Coach §4.3 step 2, §6.4: the result as the server answers it, with the tally of what the call served when it
  // served anything, measured before anything commits; past `TOOL_RESULT_BYTES` the call is refused `result-too-large`,
  // its writes dropped, so no result the device cannot send is ever written.
  /** @param {AbilityRequest} request @param {AbilityAnswer} answer @param {Plan} plan @param {CoachMessageValue} coach @param {import('../../../../platform/domain-kit/time.js').Moment} moment */
  answering(request, answer, plan, coach, moment) {
    const payload = answer.payload;
    const tallied = !answer.served.isEmpty && payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload, read: answer.served.tally.json } : payload;
    const bytes = jcsBytes(tallied);
    if (bytes.length > CoachRules.maxResultBytes) return this.refusing(request, AbilityRefusals.resultTooLarge, request.input, coach, moment);
    const call = new AbilityCall({ callId: request.callId, name: request.name, input: request.input, outcome: 'ok', created: answer.created, read: answer.served });
    return this.recording(call, { kind: 'result', jcs: bytes, sha256: sha256(bytes) }, plan, coach, moment);
  }

  // The call on the Coach message, in the same gesture as the ability's writes (kit §9.3), in the fullest form the
  // message's calls hold (`recorded`): refused `coach-turn-volume`, writes dropped, when only a bare record fits the
  // bound; and refused unrecorded, as the message's own bound, when not even that fits. Calls hold no U+0000, so an input
  // that does records without itself. A call run again under a `callId` the message already holds keeps one record: this
  // run's, holding every id either run created, in the first's place when the gate admitted the first, and last
  // otherwise, as its ordinal stands. A first record that answered stands when this run was refused, and one the gate
  // admitted stands when this run's was not, so no admitted call ever gives up its ordinal.
  /** @param {AbilityCall} call @param {AbilityOutcome} outcome @param {Plan} plan @param {CoachMessageValue} coach @param {import('../../../../platform/domain-kit/time.js').Moment} moment */
  recording(call, outcome, plan, coach, moment) {
    const found = coach.calls.findIndex((each) => each.callId === call.callId);
    const prior = coach.calls[found] ?? null;
    const answered = prior?.isOk === true;
    if ((answered && !call.isOk) || (prior !== null && RunAbility.admitted(prior) && !RunAbility.admitted(call))) return Decision.unchanged(outcome);
    const first = prior !== null && RunAbility.admitted(prior) ? found : -1;
    const others = coach.calls.filter((_, index) => index !== found);
    const created = [...(prior?.created ?? []), ...call.created]
      .filter((ref, index, all) => all.findIndex((other) => sameJson(other, ref)) === index);
    const whole = call.with({ created });
    const storable = whole.input === null || firstNul(whole.input, new Path('input')) === null ? whole : whole.with({ input: null });
    const recorded = coach.with({ calls: others }).recorded(storable);
    if (recorded === null) return Decision.refuse(GymRefusals.ofRefused(new Refused('too-large', coach.id.ref, null, 'predicted')));
    const fits = recorded.outcome === storable.outcome;
    /** @type {AbilityOutcome} */
    const volume = { kind: 'refused', code: AbilityRefusals.volume };
    if (answered && !fits) return Decision.unchanged(volume);
    const calls = first < 0 ? [...others, recorded] : [...others.slice(0, first), recorded, ...others.slice(first)];
    if (sameJson(calls.map((each) => each.json), coach.calls.map((each) => each.json)) && plan.operations.length === 0) return Decision.unchanged(outcome);
    const written = fits ? plan : new Plan();
    written.update(new Valid(coach.with({ calls }), moment, ['calls']), { fields: ['calls'] });
    return Decision.write(written, fits ? outcome : volume);
  }
}
