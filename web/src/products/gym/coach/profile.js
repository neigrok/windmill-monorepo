import prompt from '../../../../../packages/api-contract/gym/coach/prompt.md?raw';
import firstContent from '../../../../../packages/api-contract/gym/coach/first-content.json' with { type: 'json' };
import refusals from '../../../../../packages/api-contract/gym/coach/refusals.json' with { type: 'json' };
import catalogFile from '../../../../../packages/api-contract/gym/catalog-3.json' with { type: 'json' };
import { Catalog } from '../../../platform/domain-kit/abilities.js';
import { AbilityRefusals } from '../domain/coach/conversation.js';

// The words Coach's model reads in a turn: the contract's own files (packages/api-contract/gym/coach/README.md), which
// every app ships as they are.
export const COACH_WORDS = Object.freeze({ prompt, firstContent, refusals });

// The web offers no workout proposal: its room is closed while a workout is open (gym Coach on the AI service §3).
const NOT_ON_THE_WEB = Object.freeze(['propose_workout_change']);

const GROUPS = Object.freeze([
  { name: 'routine-proposal', tools: ['propose_routine_change', 'propose_routine_removal'], maxSuccesses: 1, code: 'one-proposal' },
  { name: 'note', tools: ['save_note'], maxSuccesses: 1, code: 'one-note' },
]);

// Gym's profile for the Coach engine, for each seat (gym Coach on the AI service §3): catalog/3's tools the seat is
// offered, each strict as the catalog states it, the words every app ships, the limits of phone-hosted Coach abilities
// Appendix A and the groups the gate allows once. The engine builds the first content around what the host gives it,
// so the words of history and context are put together here, as the server puts them together.
export class GymProfile {
  static name = 'gym.coach';
  static version = 1;

  constructor(catalog = new Catalog(catalogFile), words = COACH_WORDS) {
    this.catalog = catalog;
    this.words = words;
  }

  /** @param {'bound' | 'anon'} seat */
  of(seat) {
    const tools = this.catalog.offered(seat).filter((ability) => !NOT_ON_THE_WEB.includes(ability.name));
    const offered = new Set(tools.map((ability) => ability.name));
    return {
      name: GymProfile.name,
      version: GymProfile.version,
      system: [this.words.prompt],
      firstContent: { historyPrefix: '', contextPrefix: '', questionPrefix: '', emptyQuestion: this.words.firstContent.pictureOnlyQuestion },
      refusals: this.sentences(),
      tools: tools.map((ability) => ({ name: ability.name, description: ability.description, input: ability.input,
        countsAsWrite: ability.kind === 'add', strict: ability.strict })),
      groups: GROUPS.filter((group) => group.tools.every((name) => offered.has(name))).map((group) => ({ ...group, tools: [...group.tools] })),
      model: 'large',
      effort: seat === 'bound' ? 'medium' : 'low',
      output: { maxTokens: 2_000, minTokens: 1_024 },
      label: 'coach',
      limits: { modelCalls: 8, abilityCalls: 12, writes: 6 },
    };
  }

  // The earlier conversation as one block, oldest first, each line under its speaker's name; nothing when there is none.
  /** @param {readonly import('../domain/coach/conversation.js').CoachMessageValue[]} messages */
  history(messages) {
    if (messages.length === 0) return '';
    const earlier = this.words.firstContent.earlierConversation;
    return earlier.marker + messages.map((message) => `\n\n${earlier[message.role]}: ${message.text}`).join('');
  }

  // A context read as the model reads it: its lead sentence, then its result in canonical form.
  /** @param {string} ability @param {Uint8Array} result */
  context(ability, result) {
    return `${this.words.firstContent.contextLeads[ability]}\n${new TextDecoder().decode(result)}`;
  }

  // The sentence beside each code the model may read. `one-proposal` names its target, the web's one proposal being a
  // routine's; `invalid-input` and the executor's own codes have no sentence in the words, so the model reads the code.
  sentences() {
    const said = { ...this.words.refusals, 'one-proposal': this.words.refusals['one-proposal'].replace('{target}', 'routine') };
    for (const code of [...Object.values(AbilityRefusals), 'one-note']) if (!Object.hasOwn(said, code)) said[code] = '';
    return said;
  }
}
