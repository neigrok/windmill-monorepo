// The showcase tree: a legible "Living room makeover" roadmap, structured so the
// layered layout stays clean. Every edge is a single-rank hop — the spine is the
// critical path, side tasks (palette, floor-seal, accent light, smart hub) are
// short leaf branches that complete rather than merging back late, and the only
// merges are local diamonds between same-rank siblings (demo, delivery, finish).
// No hand-nudged positions.

export const handAuthoredTree = {
  id: 'living-room-makeover',
  title: 'Living Room Makeover',
  nodes: [
    { id: 'plan', label: 'Plan & measure', icon: 'ruler', prerequisites: [] },

    { id: 'budget', label: 'Set the budget', icon: 'wallet', prerequisites: ['plan'] },
    { id: 'moodboard', label: 'Build a mood board', icon: 'image', prerequisites: ['plan'] },

    { id: 'palette', label: 'Choose the palette', icon: 'palette', prerequisites: ['moodboard'] },
    { id: 'hire', label: 'Hire a contractor', icon: 'hard-hat', prerequisites: ['budget'] },
    { id: 'clear', label: 'Clear the room', icon: 'package', prerequisites: ['budget'] },

    { id: 'demo', label: 'Demo old fixtures', icon: 'hammer', prerequisites: ['clear', 'hire'] },

    { id: 'patch', label: 'Patch & prime walls', icon: 'paint-roller', prerequisites: ['demo'] },
    { id: 'sand', label: 'Sand the floors', icon: 'layers', prerequisites: ['demo'] },
    { id: 'electrical', label: 'Electrical rough-in', icon: 'plug', prerequisites: ['demo'] },
    { id: 'plumbing', label: 'Check the plumbing', icon: 'droplet', prerequisites: ['demo'] },

    { id: 'paint', label: 'Paint the walls', icon: 'paintbrush', prerequisites: ['patch'] },
    { id: 'refinish', label: 'Refinish the floors', icon: 'layers', prerequisites: ['sand'] },
    { id: 'lighting', label: 'Install light fixtures', icon: 'lamp', prerequisites: ['electrical'] },
    { id: 'thermostat', label: 'Smart thermostat', icon: 'thermometer', prerequisites: ['plumbing'] },

    { id: 'seal', label: 'Seal & finish floors', icon: 'spray-can', prerequisites: ['refinish'] },
    { id: 'accent', label: 'Add accent lighting', icon: 'sun', prerequisites: ['lighting'] },
    { id: 'smarthub', label: 'Add a smart hub', icon: 'wifi', prerequisites: ['thermostat'] },
    { id: 'furniture', label: 'Pick the furniture', icon: 'sofa', prerequisites: ['paint'] },

    { id: 'sofa', label: 'Order the sofa', icon: 'shopping-cart', prerequisites: ['furniture'] },
    { id: 'table', label: 'Order coffee table', icon: 'layout-grid', prerequisites: ['furniture'] },
    { id: 'shelving', label: 'Order the shelving', icon: 'library', prerequisites: ['furniture'] },
    { id: 'storage', label: 'Order storage bench', icon: 'archive', prerequisites: ['furniture'] },

    { id: 'delivery', label: 'Delivery & assembly', icon: 'truck', prerequisites: ['sofa', 'table', 'shelving', 'storage'] },

    { id: 'arrange', label: 'Arrange the layout', icon: 'move', prerequisites: ['delivery'] },

    { id: 'curtains', label: 'Hang the curtains', icon: 'sun', prerequisites: ['arrange'] },
    { id: 'shelfstyle', label: 'Style the shelves', icon: 'book-open', prerequisites: ['arrange'] },
    { id: 'plants', label: 'Add plants', icon: 'sprout', prerequisites: ['arrange'] },
    { id: 'art', label: 'Hang the wall art', icon: 'frame', prerequisites: ['arrange'] },
    { id: 'media', label: 'Set up TV & media', icon: 'tv', prerequisites: ['arrange'] },
    { id: 'pillows', label: 'Style throw pillows', icon: 'sparkles', prerequisites: ['arrange'] },

    { id: 'clean', label: 'Deep clean & finish', icon: 'check', prerequisites: ['curtains', 'shelfstyle', 'plants', 'art', 'media', 'pillows'] },
    { id: 'photo', label: 'Photograph the room', icon: 'camera', prerequisites: ['clean'] },
    { id: 'celebrate', label: 'Celebrate & host', icon: 'gift', prerequisites: ['photo'] },
  ],
};
