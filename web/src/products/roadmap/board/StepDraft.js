import { UnlockRules } from '../model/UnlockRules.js';
import { DEFAULT_NODE_COLOR } from '../theme.js';
import { COLUMN_TITLES, COMPOSER, PICKER, STEP_DETAIL, afterStep, placementPreview } from './copy.js';

const DEFAULT_DRAFT_COLOR = 'sky';
const PAGE_SIZE = 20;
const COLUMN_OF_STATE = { complete: 'done', available: 'upNext', locked: 'locked' };
const PICKER_COLUMNS = ['done', 'upNext', 'locked'];

export class StepDraft {
  constructor({ id = crypto.randomUUID(), name = '', description = '', color = DEFAULT_DRAFT_COLOR, prerequisites = [] } = {}) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.color = color;
    this.prerequisites = Object.freeze([...new Set(prerequisites)]);
    Object.freeze(this);
  }

  with(change) {
    return new StepDraft({ ...this, ...change, id: this.id });
  }

  get dirty() {
    return this.name !== '' || this.description !== '' || this.color !== DEFAULT_DRAFT_COLOR || this.prerequisites.length > 0;
  }

  validate() {
    return { name: this.name.trim() ? null : COMPOSER.nameRequired };
  }

  reconcile(tree) {
    const prerequisites = this.prerequisites.filter((id) => tree.nodesById.has(id));
    if (prerequisites.length === this.prerequisites.length) return this;
    return this.with({ prerequisites });
  }

  placement(tree, completed) {
    const draft = this.reconcile(tree);
    const states = UnlockRules.derive({ nodes: [...tree.nodes, draft] }, { completed });
    const prerequisites = draft.prerequisites.map((id) => tree.nodesById.get(id));
    const unmet = prerequisites.filter((step) => states.get(step.id) !== 'complete');
    const unmetLabels = unmet.map((step) => step.label?.trim() ? step.label : STEP_DETAIL.unnamed);
    const preview = placementPreview({ prerequisites, unmet: unmetLabels });
    return { ...preview, column: COLUMN_OF_STATE[states.get(draft.id)] };
  }

  toCreateRequest(tree) {
    const draft = tree ? this.reconcile(tree) : this;
    return new CreateStepRequest({ ...draft, label: draft.name });
  }
}

export class CreateStepRequest {
  constructor({ id, label, description, color, prerequisites }) {
    const name = label.trim();
    if (!name) throw new TypeError('A step requires a non-empty label');
    this.id = id;
    this.label = name;
    this.description = description;
    this.color = color;
    this.prerequisites = Object.freeze([...prerequisites]);
    Object.freeze(this);
  }
}

export class PrerequisiteChoices {
  constructor(tree, completed, { selected = [], query = '', limit = PAGE_SIZE } = {}) {
    this.tree = tree;
    this.completed = completed;
    this.query = query;
    this.limit = limit;
    this.selectedIds = Object.freeze([...new Set(selected)].filter((id) => tree.nodesById.has(id)));

    const chosen = new Set(this.selectedIds);
    const states = UnlockRules.derive(tree, { completed });
    const labels = new Map(tree.nodes.map((step) => [step.id, step.label?.trim() ? step.label : STEP_DETAIL.unnamed]));
    const titleCounts = new Map();
    for (const step of tree.nodes) {
      const title = labels.get(step.id).trim().toLowerCase();
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }

    const candidates = tree.nodes.map((step) => {
      const column = COLUMN_OF_STATE[states.get(step.id)];
      const parent = tree.nodesById.get(step.prerequisites[0]);
      const label = labels.get(step.id);
      const collision = titleCounts.get(label.trim().toLowerCase()) > 1;
      return Object.freeze({
        id: step.id,
        label,
        color: step.color ?? DEFAULT_NODE_COLOR,
        state: COLUMN_TITLES[column],
        column,
        context: collision ? (parent ? afterStep({ step: labels.get(parent.id) }) : PICKER.startingStep) : null,
        selected: chosen.has(step.id),
      });
    });
    const byId = new Map(candidates.map((row) => [row.id, row]));
    const asked = query.trim().toLowerCase();
    const matches = candidates.filter((row) => row.label.toLowerCase().includes(asked));
    const ordered = PICKER_COLUMNS.flatMap((column) => matches.filter((row) => row.column === column));

    this.total = candidates.length;
    this.count = matches.length;
    this.rows = Object.freeze(ordered.slice(0, limit));
    this.selected = Object.freeze(this.selectedIds.map((id) => byId.get(id)));
    Object.freeze(this);
  }

  get fits() { return this.total <= 8; }
  get hasMore() { return this.rows.length < this.count; }
  get nextCount() { return Math.min(PAGE_SIZE, this.count - this.rows.length); }

  search(query) {
    return new PrerequisiteChoices(this.tree, this.completed, { selected: this.selectedIds, query });
  }

  toggle(id) {
    if (!this.tree.nodesById.has(id)) return this;
    const selected = this.selectedIds.includes(id) ? this.selectedIds.filter((chosen) => chosen !== id) : [...this.selectedIds, id];
    return new PrerequisiteChoices(this.tree, this.completed, { selected, query: this.query, limit: this.limit });
  }

  more() {
    if (!this.hasMore) return this;
    return new PrerequisiteChoices(this.tree, this.completed, { selected: this.selectedIds, query: this.query, limit: this.limit + PAGE_SIZE });
  }

  reconcile(tree, completed) {
    if (tree === this.tree && completed === this.completed) return this;
    return new PrerequisiteChoices(tree, completed, { selected: this.selectedIds, query: this.query, limit: this.limit });
  }

  differsFrom(ids) {
    const live = new Set(ids.filter((id) => this.tree.nodesById.has(id)));
    return this.selectedIds.length !== live.size || this.selectedIds.some((id) => !live.has(id));
  }
}
