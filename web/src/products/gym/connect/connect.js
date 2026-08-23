import { readScope } from '../../../shell/auth/scopes.js';
import { shortDayLabel } from '../log.js';

export const PITCH_TITLE = 'Your training log, inside your own Claude.';
export const PITCH_LINE =
  'Not a chat in another tab. The twelve weeks of squats you already logged, readable by the '
  + 'assistant you already use.';

export const EXCHANGE = {
  askedLabel: 'Sunday, in your own tool',
  asked:
    '“Look at my last twelve weeks of bench. Write me a four-week block — heavier triples, and '
    + 'swap the flies for incline work.”',
  landedLabel: 'Monday, in gym',
  landed: 'A proposal on Push A. You read the diff, you tap Apply, you train.',
};

export const PITCH_POINTS = [
  'Nothing to install and no API key to paste — one URL into the tool you already use, approved in your browser.',
  'It reads, and it proposes: a change to a day you already have arrives as a diff and waits for your tap. A brand-new day it adds lands right away — that takes nothing away, and the day is yours to edit in Routines.',
  'One account across Roadmap, Journal and Gym.',
];

export const PRECONDITION =
  'Needs an AI tool of your own that speaks MCP — Claude Desktop, Claude Code, Cursor, Codex, or any '
  + 'other MCP client. If you haven’t got one, this one is not for you yet, and the log stays free '
  + 'regardless.';

export const FREE_LINE =
  'Connecting your log costs nothing, and neither does the log: the logger, your history, routines, '
  + 'records and the CSV are free. There is nothing in gym to buy.';

export const INVITATION_KICKER = 'The connected log';
export const INVITATION_LINE =
  'The tool you already use can read these weeks and write you the next block: a new day lands, and '
  + 'a change to a day you already have waits for your tap.';
export const INVITATION_VERB = 'Connect your log';
export const INVITATION_FREE = 'It costs nothing.';

export const GRANT_LINE = 'Windmill speaks MCP, and one URL is the whole of it.';

export const LEVEL_LINES = {
  read: 'Read your log — sets, workouts, routines, records and how your gym is set up',
  write: 'Record what happened · add a new day or a new movement · propose changes to the days you have · share one workout by link',
  delete: 'Discard a workout · end a share link · propose a removal',
};

const LEVEL_ORDER = ['read', 'write', 'delete'];

export const NEVER = [
  'Change a day of your program that already stands. That arrives as a typed diff and waits for your tap — and the connection cannot tap it either: there is no apply tool at any grant level. Whichever way you decide, every workout already trained under that routine keeps the copy it was trained against.',
  'Edit or delete one set you logged. No tool at any level touches an individual set, so correcting what you lifted stays yours, in the app.',
  'See a level you did not approve. Delete is never implied by write, and a level you withheld is a tool the connection cannot so much as list.',
];

export const APPROVE_WITH_CARE =
  'A level you approve is real reach: write records into your log without asking, and delete can '
  + 'discard a whole workout and every set in it — permanently, with no undo. Approve each one for a '
  + 'tool you would hand that to.';

export const DISCONNECT_LINE =
  'Disconnect a tool any time in Settings → Connected tools, and revoke a personal key in Settings → '
  + 'API keys. Either one stops every read at once and takes nothing away: every proposal already in '
  + 'your history stays, and so does everything the tool wrote into your log.';

export const WORKBENCH_HREF = '#/connect';
export const WORKBENCH_VERB = 'Connect a tool';

export const NOTHING_CONNECTED = 'No tool reads your log yet.';

export const PERSONAL_KEY_NOTE =
  'A key you minted yourself. It carries the whole account — every product, every level — because a '
  + 'personal key has no levels to pick.';

// An empty grant scope is account-wide; a personal key always is.
export function connectionsToTheLog(grants, keys) {
  const rows = [];
  for (const grant of grants ?? []) {
    const scope = readScope(grant.scope);
    const gym = scope.products.find((each) => each.product === 'gym');
    if (!scope.accountWide && !gym) continue;
    rows.push({
      id: `grant:${grant.clientId}`,
      name: grant.name || grant.clientId,
      since: grant.grantedMs,
      levels: scope.accountWide ? LEVEL_ORDER : gym.levels,
      personal: false,
    });
  }
  for (const key of keys ?? []) {
    rows.push({
      id: `key:${key.id}`,
      name: key.name || 'Unnamed key',
      since: key.createdMs,
      levels: LEVEL_ORDER,
      personal: true,
    });
  }
  return rows;
}

// `since` is when the credential was made, never a last read.
export function connectedLabel(row) {
  const verb = row.personal ? 'minted' : 'connected';
  return `${verb} ${shortDayLabel(row.since)}   ·   ${row.levels.join(' · ')}`;
}
