// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Roadmap, RoadmapMeta, RoadmapMetaValue, RoadmapValue } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapLink, RoadmapLinkValue, RoadmapStep, RoadmapStepValue } from '../../../../src/products/roadmap/domain/steps.js';
import { RoadmapKind, RoadmapKindValue } from '../../../../src/products/roadmap/domain/kinds.js';
import { StepMark, StepMarkValue, StepPointer, StepPointerValue } from '../../../../src/products/roadmap/domain/progress.js';
import { StepLink, StepLinkValue, StepNote, StepNoteValue, Subtask, SubtaskValue } from '../../../../src/products/roadmap/domain/workspace.js';
import { RoadmapRefusals } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { RoadmapRules } from '../../../../src/products/roadmap/domain/ruleBook.js';
import { RegistryCheck, RuleBookCheck, RuleBookParity } from '../../../platform/domain-kit/checks.js';
import { roadmapRegistry } from './actionVectors.js';

const book = new RoadmapRules(roadmapRegistry).book;
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
  ];
  for (const [type, sample] of /** @type {[any, any][]} */ (samples)) assert.doesNotThrow(() => RegistryCheck.entity(type, sample, book), type.type);
});

test('the rule book is the one pinned in rules.json', () => {
  RuleBookParity.check(book, 'roadmap/domain/rules.json');
});

test('every rule has its vector and every code maps to a roadmap refusal on both paths', () => {
  const actions = ['roadmaps', 'steps', 'kinds', 'progress', 'workspace', 'landing'].map((name) => `roadmap/domain/${name}-actions.json`);
  RuleBookCheck.check(book, RoadmapRefusals, 'roadmap/domain/values.json', actions);
});
