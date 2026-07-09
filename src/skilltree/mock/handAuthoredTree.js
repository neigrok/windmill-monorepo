// The showcase tree: a real, legible roadmap ("Living room makeover") that
// extends the flavor of the design-system's 5-node demo into a full ~40-step
// project. DAG with several diamonds (nodes with 2+ prerequisites) and a
// handful of manual position nudges for character.

export const handAuthoredTree = {
  id: 'living-room-makeover',
  title: 'Living Room Makeover',
  nodes: [
    { id: 'plan-measure', label: 'Plan & measure', icon: 'ruler', prerequisites: [] },
    { id: 'set-budget', label: 'Set the budget', icon: 'wallet', prerequisites: [] },

    { id: 'mood-board', label: 'Build a mood board', icon: 'image', prerequisites: ['plan-measure'], position: { x: -60, y: 180 } },
    { id: 'choose-palette', label: 'Choose color palette', icon: 'palette', prerequisites: ['mood-board'] },
    { id: 'hire-contractor', label: 'Hire a contractor', icon: 'hard-hat', prerequisites: ['set-budget'] },
    { id: 'get-permits', label: 'Pull permits', icon: 'clipboard-check', prerequisites: ['hire-contractor'] },

    { id: 'clear-room', label: 'Clear the room', icon: 'package', prerequisites: ['plan-measure'] },
    { id: 'demo-fixtures', label: 'Demo old fixtures', icon: 'hammer', prerequisites: ['clear-room', 'get-permits'] },
    { id: 'patch-walls', label: 'Patch & prime walls', icon: 'paint-roller', prerequisites: ['demo-fixtures'] },
    { id: 'sand-floors', label: 'Sand the floors', icon: 'layers', prerequisites: ['demo-fixtures'] },
    { id: 'electrical-roughin', label: 'Electrical rough-in', icon: 'plug', prerequisites: ['demo-fixtures'] },
    { id: 'plumbing-check', label: 'Check plumbing', icon: 'droplet', prerequisites: ['demo-fixtures'] },
    { id: 'hvac-tuneup', label: 'HVAC tune-up', icon: 'thermometer', prerequisites: ['electrical-roughin'] },
    { id: 'smart-thermostat', label: 'Install smart thermostat', icon: 'zap', prerequisites: ['hvac-tuneup'] },

    { id: 'paint-walls', label: 'Paint the walls', icon: 'paintbrush', prerequisites: ['patch-walls', 'choose-palette'] },
    { id: 'refinish-floors', label: 'Refinish floors', icon: 'layers', prerequisites: ['sand-floors'] },
    { id: 'floor-sealant', label: 'Seal & finish floors', icon: 'spray-can', prerequisites: ['refinish-floors'] },

    { id: 'lighting-plan', label: 'Plan lighting layout', icon: 'compass', prerequisites: ['choose-palette', 'electrical-roughin'] },
    { id: 'install-fixtures', label: 'Install light fixtures', icon: 'lamp', prerequisites: ['lighting-plan', 'paint-walls'] },
    { id: 'ceiling-fan', label: 'Add a ceiling fan', icon: 'fan', prerequisites: ['electrical-roughin'] },
    { id: 'accent-lighting', label: 'Add accent lighting', icon: 'sun', prerequisites: ['install-fixtures'] },

    { id: 'pick-furniture', label: 'Pick furniture', icon: 'sofa', prerequisites: ['paint-walls', 'set-budget'] },
    { id: 'order-sofa', label: 'Order the sofa', icon: 'shopping-cart', prerequisites: ['pick-furniture'] },
    { id: 'order-table', label: 'Order coffee table', icon: 'layout-grid', prerequisites: ['pick-furniture'] },
    { id: 'order-shelving', label: 'Order shelving unit', icon: 'library', prerequisites: ['pick-furniture'] },
    { id: 'order-storage', label: 'Order storage bench', icon: 'archive', prerequisites: ['pick-furniture'] },
    { id: 'delivery', label: 'Delivery & assembly', icon: 'truck', prerequisites: ['order-sofa', 'order-table', 'order-shelving', 'order-storage'] },

    { id: 'arrange-layout', label: 'Arrange furniture layout', icon: 'move', prerequisites: ['delivery', 'refinish-floors'] },
    { id: 'rugs', label: 'Lay down rugs', icon: 'grid-3x3', prerequisites: ['arrange-layout'] },
    { id: 'curtains', label: 'Hang curtains', icon: 'sun', prerequisites: ['install-fixtures', 'arrange-layout'] },
    { id: 'style-shelves', label: 'Style the shelves', icon: 'book-open', prerequisites: ['order-shelving', 'arrange-layout'] },
    { id: 'add-plants', label: 'Add plants', icon: 'sprout', prerequisites: ['arrange-layout'], position: { x: -30, y: 1150 } },
    { id: 'wall-art', label: 'Hang wall art', icon: 'frame', prerequisites: ['paint-walls', 'arrange-layout'] },

    { id: 'tv-setup', label: 'Set up TV & media', icon: 'tv', prerequisites: ['delivery', 'electrical-roughin'] },
    { id: 'speaker-system', label: 'Wire the speaker system', icon: 'speaker', prerequisites: ['tv-setup'] },
    { id: 'smart-hub', label: 'Add a smart home hub', icon: 'wifi', prerequisites: ['smart-thermostat', 'tv-setup'] },
    { id: 'fireplace-touch', label: 'Refresh the fireplace', icon: 'flame', prerequisites: ['paint-walls'], position: { x: 640, y: 900 } },

    { id: 'throw-pillows', label: 'Style throw pillows', icon: 'sparkles', prerequisites: ['order-sofa', 'curtains'] },
    { id: 'final-clean', label: 'Deep clean & final touches', icon: 'check', prerequisites: ['rugs', 'wall-art', 'add-plants', 'style-shelves', 'throw-pillows'] },
    { id: 'photo-day', label: 'Photograph the finished room', icon: 'camera', prerequisites: ['final-clean'] },
    { id: 'celebrate', label: 'Celebrate & host friends', icon: 'gift', prerequisites: ['photo-day', 'smart-hub'], position: { x: 280, y: 1450 } },
  ],
};
