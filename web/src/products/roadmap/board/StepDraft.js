import { UnlockRules } from '../model/UnlockRules.js';
import { DEFAULT_NODE_COLOR, NODE_COLOR_NAMES } from '../theme.js';
import { COLUMN_TITLES, COMPOSER, PICKER, afterStep, placementPreview } from './copy.js';

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
    const preview = placementPreview({ prerequisites, unmet: unmet.map((step) => step.label) });
    return { ...preview, column: COLUMN_OF_STATE[states.get(draft.id)] };
  }

  toCreateRequest(tree) {
    const draft = tree ? this.reconcile(tree) : this;
    return new CreateStepRequest({ ...draft, label: draft.name });
  }

  static kinds(legend = []) {
    const named = new Map();
    for (const kind of legend) {
      if (NODE_COLOR_NAMES.includes(kind.hue) && kind.label?.trim() && !named.has(kind.hue)) {
        named.set(kind.hue, { hue: kind.hue, label: kind.label });
      }
    }
    return [
      ...named.values(),
      ...NODE_COLOR_NAMES.filter((hue) => !named.has(hue)).map((hue) => ({ hue, label: `${hue[0].toUpperCase()}${hue.slice(1)}` })),
    ];
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
    const titleCounts = new Map();
    for (const step of tree.nodes) {
      const title = step.label.trim().toLowerCase();
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }

    const candidates = tree.nodes.map((step) => {
      const column = COLUMN_OF_STATE[states.get(step.id)];
      const parent = tree.nodesById.get(step.prerequisites[0]);
      const collision = titleCounts.get(step.label.trim().toLowerCase()) > 1;
      return Object.freeze({
        id: step.id,
        label: step.label,
        color: step.color ?? DEFAULT_NODE_COLOR,
        state: COLUMN_TITLES[column],
        column,
        context: collision ? (parent ? afterStep({ step: parent.label }) : PICKER.startingStep) : null,
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
    this.groups = Object.freeze(PICKER_COLUMNS.map((column) => Object.freeze({
      column, rows: Object.freeze(this.rows.filter((row) => row.column === column)),
    })).filter((group) => group.rows.length > 0));
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
