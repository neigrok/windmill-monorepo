// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Roadmap, RoadmapMeta, RoadmapMetaValue, RoadmapValue } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapLink, RoadmapLinkValue, RoadmapStep, RoadmapStepValue } from '../../../../src/products/roadmap/domain/steps.js';
import { RoadmapKind, RoadmapKindValue } from '../../../../src/products/roadmap/domain/kinds.js';
import { StepMark, StepMarkValue, StepPointer, StepPointerValue } from '../../../../src/products/roadmap/domain/progress.js';
import { StepLink, StepLinkValue, StepNote, StepNoteValue, Subtask, SubtaskValue } from '../../../../src/products/roadmap/domain/workspace.js';
import { CoachMessage, CoachMessageValue, CoachProposal, CoachThread, CoachThreadValue, CoachWriteFate, CoachPicture } from '../../../../src/products/roadmap/domain/conversation.js';
import { Instant } from '../../../../src/platform/domain-kit/time.js';
import { GENESIS_KINDS, RoadmapRefusals, SAFE_URL } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { DEFAULT_KINDS } from '../../../../../packages/api-contract/genesis.js';
import { RegistryCheck, RuleBookCheck, RuleBookParity } from '../../../platform/domain-kit/checks.js';
import { roadmapBook } from './vectors.js';

const book = roadmapBook;
const T = 't_0000000000000001';

test('every roadmap entity agrees with the registry, its sample setting every field it writes', () => {
  const samples = [
    [Roadmap, new RoadmapValue(new Id(T, Roadmap))],
    [RoadmapMeta, new RoadmapMetaValue(new Id('meta', RoadmapMeta), { title: 'Learn Rust', guide: 'One step a day.' })],
    [RoadmapStep, new RoadmapStepValue(new Id('basics', RoadmapStep), { label: 'Basics', icon: 'book', color: 'olive', ord: 'a0', description: 'Start here.',
      links: [{ url: 'https://doc.rust-lang.org', label: 'Docs' }] })],
    [RoadmapLink, new RoadmapLinkValue('basics', 'ownership')],
    [RoadmapKind, new RoadmapKindValue(new Id('learn', RoadmapKind), { hue: 'olive', label: 'Learn', description: 'Things you figure out', ord: 'a1' })],
    [StepMark, new StepMarkValue(new Id('basics', StepMark), 'complete', true)],
    [StepPointer, new StepPointerValue(new Id('basics', StepPointer), T)],
    [Subtask, new SubtaskValue(new Id('sub00001', Subtask), 'basics', { label: 'Install rustup', done: true })],
    [StepLink, new StepLinkValue(new Id('lnk00001', StepLink), 'basics', { url: 'https://www.rust-lang.org', title: 'Rust' })],
    [StepNote, new StepNoteValue(new Id('basics', StepNote), 'Moves, not copies.')],
    [CoachThread, new CoachThreadValue(new Id('thread0001', CoachThread), { treeId: T, stepId: 'basics', title: 'What should I do next?' })],
    [CoachMessage, new CoachMessageValue({ id: new Id('message0002', CoachMessage), threadId: new Id('thread0001', CoachThread), role: 'coach',
      replica: 'rp_00000000000000000000000000000001', text: 'Start with the basics.', state: 'failed', truncated: true, refusal: 'host-fault',
      pictures: [new CoachPicture('picture1', 'image/png')], at: new Instant(1800000000000) })],
    [CoachProposal, null],
    [CoachWriteFate, null],
  ];
  for (const [type, sample] of /** @type {[any, any][]} */ (samples)) assert.doesNotThrow(() => RegistryCheck.entity(type, sample, book), type.type);
});

test('the rule book is the one pinned in rules.json', () => {
  RuleBookParity.check(book, 'roadmap/domain/rules.json');
});

test('every rule has its vector and every code maps to a roadmap refusal on both paths', () => {
  const actions = ['roadmaps', 'steps', 'kinds', 'progress', 'workspace', 'landing', 'conversation'].map((name) => `roadmap/domain/${name}-actions.json`);
  RuleBookCheck.check(book, RoadmapRefusals, 'roadmap/domain/values.json', actions);
});

test("a new roadmap's genesis kinds are the server's", () => {
  assert.deepEqual(GENESIS_KINDS, DEFAULT_KINDS);
});

// packages/api-contract/roadmap-link-urls.json: the backend takes exactly the link urls this vector marks shown, and
// SAFE_URL shows exactly those.
test('a link url is shown exactly when the shared vector says the server takes it', () => {
  const vector = /** @type {{ cases: { url: string, shown: boolean }[] }} */ (JSON.parse(readFileSync(new URL('../../../../../packages/api-contract/roadmap-link-urls.json', import.meta.url), 'utf8')));
  assert.equal(vector.cases.length, 17);
  assert.deepEqual(vector.cases.map((one) => [one.url, SAFE_URL.test(one.url)]), vector.cases.map((one) => [one.url, one.shown]));
});
