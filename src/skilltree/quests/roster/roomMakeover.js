// Starter quest (F5 §03): one room in two weekends — clear and prep before you
// paint, paint before you place, style last.

export default {
  id: 'room-makeover',
  title: 'Room makeover',
  audience: 'life',
  estimate: 'two weekends',
  source: null,
  kinds: [
    { id: 'make', hue: 'terracotta', label: 'Make', description: 'Color, texture, and the finishing touches' },
    // Not id 'build': that's a seeded default wearing terracotta, and recoloring it in
    // place would keep its rank — the planted legend would read Build, Make while the
    // card's dots promised Make, Build. A fresh id lands in the card's own order.
    { id: 'assemble', hue: 'sky', label: 'Build', description: 'The clearing, fixing, and assembling' },
  ],
  nodes: [
    {
      id: 'sketch-the-plan-and-pick-the-palette',
      label: 'Sketch the plan and pick the palette',
      color: 'terracotta',
      prerequisites: [],
      description: 'Measure the room, sketch where everything will go, and pick a shortlist of two or three colors — surfaces for weekend one, furniture and styling for weekend two. Done when the whole plan fits on one page.',
    },
    {
      id: 'clear-the-room-to-bare-walls',
      label: 'Clear the room to bare walls',
      color: 'sky',
      prerequisites: ['sketch-the-plan-and-pick-the-palette'],
      description: 'Move everything out or into the middle under an old sheet, sorting as you go into keep, donate, and toss. Done when every wall is reachable and the donate pile is bagged by the door.',
    },
    {
      id: 'swatch-test-then-buy-the-paint',
      label: 'Swatch-test, then buy the paint',
      color: 'terracotta',
      prerequisites: ['sketch-the-plan-and-pick-the-palette'],
      description: 'Paint big swatches of your shortlist on the wall and look at them in morning and evening light before committing. Done when paint for two coats, rollers, tape, filler, and sandpaper are all in the room.',
    },
    {
      id: 'patch-sand-and-wash-the-walls',
      label: 'Patch, sand, and wash the walls',
      color: 'sky',
      prerequisites: ['clear-the-room-to-bare-walls', 'swatch-test-then-buy-the-paint'],
      description: 'Fill the old holes, sand them flush, and wash the walls down so the paint has something clean to grip. Done when a raking light across the wall shows no dents, bumps, or dust.',
    },
    {
      id: 'cut-in-and-roll-the-walls',
      label: 'Cut in and roll the walls',
      color: 'terracotta',
      prerequisites: ['patch-sand-and-wash-the-walls'],
      description: 'Tape the trim, cut in the edges with a brush, then roll two coats, letting the first dry fully. Done when the color reads even in daylight and the tape comes off in one clean pull.',
    },
    {
      id: 'assemble-the-new-furniture',
      label: 'Assemble the new furniture',
      color: 'sky',
      prerequisites: ['cut-in-and-roll-the-walls'],
      description: 'Build the flat-pack pieces in the room they will live in, with the hardware sorted before you start. Done when everything stands square and no mystery screws are left in the bag.',
    },
    {
      id: 'mount-the-shelves-and-curtain-rod',
      label: 'Mount the shelves and curtain rod',
      color: 'sky',
      prerequisites: ['cut-in-and-roll-the-walls'],
      description: 'Find the studs or use proper anchors, level everything twice, and drill once. Done when the shelves hold your heaviest books without a wobble.',
    },
    {
      id: 'move-everything-back-with-intent',
      label: 'Move everything back with intent',
      color: 'sky',
      prerequisites: ['assemble-the-new-furniture', 'mount-the-shelves-and-curtain-rod'],
      description: 'Bring back only what earned its place in the plan, arranged the way you sketched it. Done when the room works — doors clear, outlets reachable, floor visible.',
    },
    {
      id: 'style-the-shelves-and-hang-the-art',
      label: 'Style the shelves and hang the art',
      color: 'terracotta',
      prerequisites: ['move-everything-back-with-intent'],
      description: 'Hang the art at eye level, dress the shelves, and add the lamp, plant, or throw that makes it yours. Done when you catch yourself pausing in the doorway to look at the room.',
    },
  ],
};
