// The showcase tree: a legible "Living room makeover" roadmap, structured so the
// layered layout stays clean. Every edge is a single-rank hop — the spine is the
// critical path, side tasks (palette, floor-seal, accent light, smart hub) are
// short leaf branches that complete rather than merging back late, and the only
// merges are local diamonds between same-rank siblings (demo, delivery, finish).
// No hand-nudged positions.
//
// `color` is the node's kind. The makeover splits into five: gold planning,
// terracotta surfaces (walls + floors), sky systems (power, water, smart),
// brick furniture, and olive styling — each a coherent region of the tree.

export const handAuthoredTree = {
  id: 'living-room-makeover',
  title: 'Living Room Makeover',
  nodes: [
    { id: 'plan', label: 'Plan & measure', icon: 'ruler', color: 'gold', prerequisites: [] },

    { id: 'budget', label: 'Set the budget', icon: 'wallet', color: 'gold', prerequisites: ['plan'] },
    { id: 'moodboard', label: 'Build a mood board', icon: 'image', color: 'gold', prerequisites: ['plan'] },

    { id: 'palette', label: 'Choose the palette', icon: 'palette', color: 'gold', prerequisites: ['moodboard'] },
    { id: 'hire', label: 'Hire a contractor', icon: 'hard-hat', color: 'gold', prerequisites: ['budget'] },
    { id: 'clear', label: 'Clear the room', icon: 'package', color: 'gold', prerequisites: ['budget'] },

    { id: 'demo', label: 'Demo old fixtures', icon: 'hammer', color: 'terracotta', prerequisites: ['clear', 'hire'] },

    { id: 'patch', label: 'Patch & prime walls', icon: 'paint-roller', color: 'terracotta', prerequisites: ['demo'] },
    { id: 'sand', label: 'Sand the floors', icon: 'layers', color: 'terracotta', prerequisites: ['demo'] },
    { id: 'electrical', label: 'Electrical rough-in', icon: 'plug', color: 'sky', prerequisites: ['demo'] },
    { id: 'plumbing', label: 'Check the plumbing', icon: 'droplet', color: 'sky', prerequisites: ['demo'] },

    { id: 'paint', label: 'Paint the walls', icon: 'paintbrush', color: 'terracotta', prerequisites: ['patch'] },
    { id: 'refinish', label: 'Refinish the floors', icon: 'layers', color: 'terracotta', prerequisites: ['sand'] },
    { id: 'lighting', label: 'Install light fixtures', icon: 'lamp', color: 'sky', prerequisites: ['electrical'] },
    { id: 'thermostat', label: 'Smart thermostat', icon: 'thermometer', color: 'sky', prerequisites: ['plumbing'] },

    { id: 'seal', label: 'Seal & finish floors', icon: 'spray-can', color: 'terracotta', prerequisites: ['refinish'] },
    { id: 'accent', label: 'Add accent lighting', icon: 'sun', color: 'sky', prerequisites: ['lighting'] },
    { id: 'smarthub', label: 'Add a smart hub', icon: 'wifi', color: 'sky', prerequisites: ['thermostat'] },
    { id: 'furniture', label: 'Pick the furniture', icon: 'sofa', color: 'brick', prerequisites: ['paint'] },

    { id: 'sofa', label: 'Order the sofa', icon: 'shopping-cart', color: 'brick', prerequisites: ['furniture'] },
    { id: 'table', label: 'Order coffee table', icon: 'layout-grid', color: 'brick', prerequisites: ['furniture'] },
    { id: 'shelving', label: 'Order the shelving', icon: 'library', color: 'brick', prerequisites: ['furniture'] },
    { id: 'storage', label: 'Order storage bench', icon: 'archive', color: 'brick', prerequisites: ['furniture'] },

    { id: 'delivery', label: 'Delivery & assembly', icon: 'truck', color: 'brick', prerequisites: ['sofa', 'table', 'shelving', 'storage'] },

    { id: 'arrange', label: 'Arrange the layout', icon: 'move', color: 'olive', prerequisites: ['delivery'] },

    { id: 'curtains', label: 'Hang the curtains', icon: 'sun', color: 'olive', prerequisites: ['arrange'] },
    { id: 'shelfstyle', label: 'Style the shelves', icon: 'book-open', color: 'olive', prerequisites: ['arrange'] },
    { id: 'plants', label: 'Add plants', icon: 'sprout', color: 'olive', prerequisites: ['arrange'] },
    { id: 'art', label: 'Hang the wall art', icon: 'frame', color: 'olive', prerequisites: ['arrange'] },
    { id: 'media', label: 'Set up TV & media', icon: 'tv', color: 'olive', prerequisites: ['arrange'] },
    { id: 'pillows', label: 'Style throw pillows', icon: 'sparkles', color: 'olive', prerequisites: ['arrange'] },

    { id: 'clean', label: 'Deep clean & finish', icon: 'check', color: 'olive', prerequisites: ['curtains', 'shelfstyle', 'plants', 'art', 'media', 'pillows'] },
    { id: 'photo', label: 'Photograph the room', icon: 'camera', color: 'olive', prerequisites: ['clean'] },
    { id: 'celebrate', label: 'Celebrate & host', icon: 'gift', color: 'olive', prerequisites: ['photo'] },
  ],
};
