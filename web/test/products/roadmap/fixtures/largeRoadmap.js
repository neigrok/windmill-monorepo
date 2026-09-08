import { nKeysBetween } from '../../../../src/products/roadmap/sync/fractionalIndex.js';

export function largeRoadmap(count, shape = 'mixed') {
  if (!Number.isInteger(count) || count < 2) throw new Error('A roadmap fixture needs at least two nodes');
  if (!['mixed', 'broad', 'deep', 'multiroot'].includes(shape)) throw new Error(`Unknown roadmap shape: ${shape}`);

  const colors = ['gold', 'sky', 'brick', 'plum', 'olive', 'terracotta'];
  const subjects = ['Foundations', 'Practice', 'Feedback', 'Experiments', 'Reflection', 'Next steps'];
  const roots = shape === 'multiroot' ? Math.min(8, count) : 1;
  const nodes = [];
  const orders = nKeysBetween(null, null, count);

  for (let index = 0; index < count; index++) {
    const id = `probe-${shape}-${String(index).padStart(5, '0')}`;
    let parent = -1;
    if (index >= roots) {
      if (shape === 'deep') parent = index % 9 === 0 ? Math.max(0, index - 8) : index - 1;
      else if (shape === 'broad') parent = index < Math.min(count, 40) ? 0 : 1 + (index - 40) % 39;
      else if (shape === 'multiroot') parent = Math.floor((index - roots) / 4);
      else if (index < 9) parent = 0;
      else if (index % 37 < 9) parent = index - 1;
      else parent = Math.max(1, Math.floor((index - 1) / (index % 3 === 0 ? 5 : 3)));
    }

    const prerequisites = parent < 0 ? [] : [nodes[parent].id];
    if (parent > 10 && index % 13 === 0) {
      const secondParent = Math.floor(parent * 0.47);
      if (secondParent !== parent) prerequisites.push(nodes[secondParent].id);
    }
    const color = parent < 0 ? colors[index % colors.length]
      : parent === 0 ? colors[index % colors.length] : nodes[parent].color;
    const subject = subjects[index % subjects.length];
    const label = index % 5 === 0
      ? `${subject} ${index + 1} · Review the evidence and choose a practical next step`
      : `${subject} ${index + 1}`;

    nodes.push({
      id, label, prerequisites, color, icon: index % 5 === 0 ? 'book-open' : 'circle',
      description: `A reproducible ${shape} roadmap step for testing layout, long labels, and prerequisite navigation.`,
      order: orders[index],
      status: index < count * 0.6 ? 'complete' : index < count * 0.66 ? 'active' : 'none',
    });
  }
  return { id: `t_probe_${shape}_${count}`, title: `${count.toLocaleString('en-US')} steps · ${shape}`, nodes };
}
