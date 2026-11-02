export class StepDraft {}

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
