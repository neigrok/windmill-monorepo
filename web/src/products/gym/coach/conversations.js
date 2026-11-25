import { Id } from '../../../platform/domain-kit/entities.js';
import { AbilityCall, CoachMessage, CoachThread, Conversation, ReadTally } from '../domain/coach/conversation.js';
import { CoachPictureRow, Mark } from '../domain/coach/turn.js';
import { Proposal } from '../domain/proposals.js';
import { ProposalDiff } from '../domain/proposalDiff.js';
import { Routine } from '../domain/routines.js';
import { Session } from '../domain/training.js';
import { WorkoutProposal } from '../domain/workoutProposals.js';
import { CONTEXT_CALL_PREFIX } from './turnHost.js';

// What a Coach message made, from the records its calls created: the routines, still standing, with their movements;
// the routine proposals and the workout proposals, this browser's or a phone's, each for its card.
function made(read, message) {
  const created = message.calls.filter((call) => call.isOk).flatMap((call) => call.created);
  const of = (type) => created.filter((ref) => ref.t === type).map((ref) => String(ref.id));
  const routines = read.repository(Routine);
  return {
    routines: of(Routine.type).map((id) => routines.find(new Id(id, Routine), 'drawn'))
      .filter((routine) => routine !== null).map((routine) => ({ id: routine.id.record, name: routine.name, movements: routine.entries.length })),
    proposals: [...new Set(of(Proposal.type))],
    workoutProposals: [...new Set(of(WorkoutProposal.type))],
  };
}

// The receipt a Coach message's calls derive, its own once its writer ended it.
function readOf(message) {
  const receipt = message.receipt ?? AbilityCall.receipt(message.calls);
  const read = receipt?.read;
  if (!read || typeof read !== 'object') return null;
  // A turn opened with a workout open reads it at its opening; when that workout is the one workout it read, the receipt
  // names it as this workout.
  const thisWorkout = read.sessions === 1 && message.calls.some((call) => call.isOk && call.callId === `${CONTEXT_CALL_PREFIX}get_session`);
  return { sets: read.sets, sessions: read.sessions, weeks: read.weeks, totalsOnly: receipt.truncated === true, thisWorkout };
}

// Each call the model asked for, in order, as What Coach read draws it: its ability, its outcome and what it served.
function stepsOf(message) {
  return message.calls.map((call) => ({ name: call.name, ok: call.isOk, context: call.callId.startsWith(CONTEXT_CALL_PREFIX),
    read: call.read instanceof ReadTally ? call.read : call.read.tally, weeks: call.read instanceof ReadTally ? [] : [...call.read.weeks] }));
}

// One conversation as the room draws it: its messages in the order they were said, each Coach message with what it made
// and read, whose turn is running here or elsewhere, and each lifter picture with its copy when this browser keeps one.
export function conversationView(read, threadId, runningHere) {
  const thread = read.repository(CoachThread).find(new Id(threadId, CoachThread), 'drawn');
  if (thread === null) return null;
  const mark = Mark.read(read);
  const messages = new Conversation(read.repository(CoachMessage).children(thread.id, 'threadId', 'drawn')).messages;
  return {
    id: thread.id.record,
    title: thread.title,
    messages: messages.map((message) => {
      if (!message.isCoach) {
        return { id: message.id.record, role: 'lifter', text: message.text, at: message.at.ms,
          pictures: message.pictures.map((picture) => ({ id: picture.id,
            copy: CoachPictureRow.decode(picture.id, read.device(CoachPictureRow.key(picture.id)))?.original ?? null })) };
      }
      const here = runningHere !== null && runningHere.equals(message.id);
      return { id: message.id.record, role: 'coach', text: message.text, at: message.at.ms, state: message.state, truncated: message.truncated,
        answering: message.state !== 'running' ? null : here ? 'here' : 'elsewhere',
        ownMark: mark.names(message.id), read: readOf(message), steps: stepsOf(message), ...made(read, message) };
    }),
  };
}

// History, one list with the phones (gym Coach on the AI service §5): every conversation, newest first, with its first
// question as its title and what its last turn made, or the first words of its last answer.
export function historyRows(read) {
  const byThread = new Map();
  for (const message of read.repository(CoachMessage).all('drawn')) {
    const held = byThread.get(message.threadId.record) ?? [];
    held.push(message);
    byThread.set(message.threadId.record, held);
  }
  const proposals = read.repository(Proposal);
  const routines = read.repository(Routine);
  const workouts = read.repository(WorkoutProposal);
  return read.repository(CoachThread).all('drawn').map((thread) => {
    const messages = new Conversation(byThread.get(thread.id.record) ?? []).messages;
    const last = messages.at(-1);
    const answer = [...messages].reverse().find((message) => message.isCoach) ?? null;
    const making = answer === null ? null : made(read, answer);
    const proposal = making?.proposals.map((id) => proposals.find(new Id(id, Proposal), 'drawn')).find((value) => value) ?? null;
    const workout = making?.workoutProposals.map((id) => workouts.find(new Id(id, WorkoutProposal), 'drawn')).find((value) => value) ?? null;
    return {
      id: thread.id.record,
      title: thread.title,
      at: last?.at.ms ?? 0,
      line: making === null ? null
        : making.routines.length ? { kind: 'created', count: making.routines.length }
          : proposal ? { kind: 'proposal', routine: proposal.baseName ?? routines.find(proposal.routineId, 'drawn')?.name ?? '',
            count: ProposalDiff.ofRoutine(proposal, routines.find(proposal.routineId, 'drawn')).blocks.length }
            : workout ? { kind: 'workout', count: workout.countChanges(read.repository(Session).find(workout.sessionId, 'stored')?.plan?.entries ?? []) }
              : answer.text ? { kind: 'words', text: answer.text.split('\n')[0] } : null,
    };
  }).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
}
