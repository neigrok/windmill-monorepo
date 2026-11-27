import { COLUMN_OF_STATE, domainReading, readEffects } from '../model/domainReads.js';
import { DEFAULT_NODE_COLOR } from '../theme.js';
import { COLUMN_TITLES, COMPOSER, PICKER, STEP_DETAIL, afterStep, placementPreview } from '../copy.js';

const DEFAULT_DRAFT_COLOR = 'sky';
const PAGE_SIZE = 20;
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
    return new StepDraft({ ...this, prerequisites });
  }

  // Where the draft lands, read from the room's reading of the roadmap: Done where the step it edits stands complete,
  // else Locked while a step it requires is not.
  placement(tree, completed) {
    const draft = this.reconcile(tree);
    const reading = domainReading(tree, { completed });
    const prerequisites = draft.prerequisites.map((id) => tree.nodesById.get(id));
    const unmet = prerequisites.filter((step) => reading.states.get(step.id) !== 'complete');
    const unmetLabels = unmet.map((step) => step.label?.trim() ? step.label : STEP_DETAIL.unnamed);
    const preview = placementPreview({ prerequisites, unmet: unmetLabels });
    const column = reading.completed.has(draft.id) ? 'done' : unmet.length ? 'locked' : 'upNext';
    return { column, body: column === 'done' ? null : preview.body };
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

// The steps the step `editing` may not come to require: itself and every step after it, as the domain reads its loops.
export function blockedPrerequisites(tree, editing) {
  if (!editing || !tree.nodesById.has(editing)) return new Set();
  return new Set(readEffects(tree, [editing]).loops?.requires ?? []);
}

export class PrerequisiteChoices {
  constructor(tree, completed, { selected = [], query = '', limit = PAGE_SIZE, editing = null, revalidated = [] } = {}) {
    this.tree = tree;
    this.completed = completed;
    this.query = query;
    this.limit = limit;
    this.editing = editing;
    this.blockedIds = blockedPrerequisites(tree, editing);
    this.selectedIds = Object.freeze([...new Set(selected)].filter((id) => tree.nodesById.has(id) && !this.blockedIds.has(id)));

    const chosen = new Set(this.selectedIds);
    const { states } = domainReading(tree, { completed });
    const labels = new Map(tree.nodes.map((step) => [step.id, step.label?.trim() ? step.label : STEP_DETAIL.unnamed]));
    const dropped = selected.filter((id) => this.blockedIds.has(id));
    this.revalidated = Object.freeze([...new Map([
      ...revalidated.map((row) => [row.id, row]),
      ...dropped.map((id) => [id, Object.freeze({ id, label: labels.get(id) })]),
    ]).values()]);
    const revalidatedIds = new Set(this.revalidated.map((row) => row.id));
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
    this.blocked = Object.freeze(matches.filter((row) => this.blockedIds.has(row.id)).map((row) => Object.freeze({
      ...row,
      reason: row.id === editing ? PICKER.thisStep : revalidatedIds.has(row.id) ? PICKER.nowComesAfter : PICKER.comesAfter,
    })));
    const selectable = matches.filter((row) => !this.blockedIds.has(row.id));
    const ordered = PICKER_COLUMNS.flatMap((column) => selectable.filter((row) => row.column === column));

    this.total = candidates.length - this.blockedIds.size;
    this.count = selectable.length;
    this.rows = Object.freeze(ordered.slice(0, limit));
    this.selected = Object.freeze(this.selectedIds.map((id) => byId.get(id)));
    Object.freeze(this);
  }

  get fits() {
    return this.total <= 8;
  }

  get hasMore() {
    return this.rows.length < this.count;
  }

  get nextCount() {
    return Math.min(PAGE_SIZE, this.count - this.rows.length);
  }

  search(query) {
    return new PrerequisiteChoices(this.tree, this.completed, { selected: this.selectedIds, query, editing: this.editing });
  }

  toggle(id) {
    if (!this.tree.nodesById.has(id) || this.blockedIds.has(id)) return this;
    const selected = this.selectedIds.includes(id)
      ? this.selectedIds.filter((chosen) => chosen !== id)
      : [...this.selectedIds, id];
    return new PrerequisiteChoices(this.tree, this.completed, { selected, query: this.query, limit: this.limit, editing: this.editing });
  }

  more() {
    if (!this.hasMore) return this;
    return new PrerequisiteChoices(this.tree, this.completed, { selected: this.selectedIds, query: this.query, limit: this.limit + PAGE_SIZE, editing: this.editing, revalidated: this.revalidated });
  }

  reconcile(tree, completed) {
    if (tree === this.tree && completed === this.completed) return this;
    return new PrerequisiteChoices(tree, completed, { selected: this.selectedIds, query: this.query, limit: this.limit, editing: this.editing, revalidated: this.revalidated });
  }

  differsFrom(ids) {
    const live = new Set(ids.filter((id) => this.tree.nodesById.has(id) && !this.blockedIds.has(id)));
    return this.selectedIds.length !== live.size || this.selectedIds.some((id) => !live.has(id));
  }
}
