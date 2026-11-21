import { DEFAULT_NODE_COLOR, NODE_COLOR_NAMES } from '../theme.js';
import { blockedPrerequisites } from './StepDraft.js';

export function fieldValue(step, field) {
  if (field === 'prerequisites') return Object.freeze([...new Set(step.prerequisites)].sort());
  if (field === 'color') return step.color ?? DEFAULT_NODE_COLOR;
  return step[field] ?? '';
}

export function sameFieldValue(field, left, right) {
  if (field !== 'prerequisites') return left === right;
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((id) => b.has(id));
}

export class InlineStepDraft {
  constructor({ editId = crypto.randomUUID(), stepId, field, baselineValue, draftValue = baselineValue, draftRevision = 0, selectionUpdated = false }) {
    if (!['label', 'description', 'color', 'prerequisites'].includes(field)) throw new TypeError('Unknown shared step field');
    this.editId = editId;
    this.stepId = stepId;
    this.field = field;
    this.baselineValue = field === 'prerequisites' ? Object.freeze([...new Set(baselineValue)].sort()) : baselineValue;
    this.draftValue = field === 'prerequisites' ? Object.freeze([...new Set(draftValue)].sort()) : draftValue;
    this.draftRevision = draftRevision;
    this.selectionUpdated = selectionUpdated;
    Object.freeze(this);
  }

  get dirty() { return !sameFieldValue(this.field, this.baselineValue, this.draftValue); }

  withValue(draftValue) {
    return new InlineStepDraft({ ...this, draftValue, draftRevision: this.draftRevision + 1 });
  }

  loadLatest(step) {
    const value = fieldValue(step, this.field);
    return new InlineStepDraft({ ...this, baselineValue: value, draftValue: value, draftRevision: this.draftRevision + 1, selectionUpdated: false });
  }

  reconcile(tree) {
    if (this.field !== 'prerequisites') return this;
    const blocked = blockedPrerequisites(tree, this.stepId);
    const draftValue = this.draftValue.filter((id) => tree.nodesById.has(id) && !blocked.has(id));
    if (draftValue.length === this.draftValue.length) return this;
    return new InlineStepDraft({ ...this, draftValue, draftRevision: this.draftRevision + 1, selectionUpdated: true });
  }

  request(expectedCurrentValue = this.baselineValue) {
    return new SaveFieldRequest({ ...this, value: this.draftValue, expectedCurrentValue });
  }
}

export class SaveFieldRequest {
  constructor({ editId, draftRevision, stepId, field, value, expectedCurrentValue }) {
    if (field === 'label') {
      value = value.trim();
      if (!value) throw new TypeError('A step requires a name');
    }
    if (field === 'color' && !NODE_COLOR_NAMES.includes(value)) throw new TypeError('Unknown step kind');
    this.editId = editId;
    this.draftRevision = draftRevision;
    this.stepId = stepId;
    this.field = field;
    this.value = field === 'prerequisites' ? Object.freeze([...new Set(value)].sort()) : value;
    this.expectedCurrentValue = field === 'prerequisites' ? Object.freeze([...new Set(expectedCurrentValue)].sort()) : expectedCurrentValue;
    Object.freeze(this);
  }

  matches(draft) { return this.editId === draft?.editId && this.draftRevision === draft?.draftRevision; }
  get sparse() { return { id: this.stepId, [this.field]: this.value }; }
}
