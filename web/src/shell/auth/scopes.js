// What a grant actually reaches, read from the OAuth `scope` string — the one thing the consent
// screen must not paraphrase. Windmill is several products behind one account, so a token minted for
// "connect my agent" can reach a skill tree, a journal or a training log, and at three different
// depths. A screen that names three roadmap verbs while the grant can delete a workout is the kind of
// wrong the root CLAUDE.md forbids, so both surfaces that show a scope — the consent card and the
// settings row — read it from here.
//
// The wire spelling is space-delimited `<product>:<level>`, and this mirrors
// backend/platform/domain/ToolScope.h, including the three cases it is easy to collapse and must not:
// an EMPTY string is the legacy account-wide grant (every token minted before scopes existed carries
// scope ''), an unreadable token confers NOTHING, and those two are opposite answers. Telling someone
// they granted everything when the token holds nothing is merely confusing; the other way round is
// the lie that matters.

const PRODUCTS = {
  roadmap: 'roadmaps',
  journal: 'journal',
  gym: 'training log',
};

// One line per level, in the person's words rather than the wire's. Each says what the tool can do
// and stops — no reassurance, and no softening of the destructive one.
const LEVELS = {
  read: { glyph: 'dim', verb: 'See' },
  write: { glyph: 'bud', verb: 'Add to and change' },
  delete: { glyph: 'gone', verb: 'Delete from' },
};

const LEVEL_ORDER = ['read', 'write', 'delete'];

export function productLabel(product) {
  return PRODUCTS[product] ?? product;
}

// The requested grant, read: `{ accountWide, products: [{ product, label, levels[] }] }`, products in
// the order they were asked for and levels in ladder order. accountWide is the legacy '' grant and
// nothing else — an unreadable scope comes back as accountWide:false with no products, which is what
// the backend enforces for it.
export function readScope(scope) {
  const tokens = String(scope ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { accountWide: true, products: [] };

  const byProduct = new Map();
  for (const token of tokens) {
    const colon = token.lastIndexOf(':');
    if (colon <= 0 || colon === token.length - 1) continue;
    const product = token.slice(0, colon);
    const level = token.slice(colon + 1);
    if (!LEVELS[level]) continue;
    if (!byProduct.has(product)) byProduct.set(product, new Set());
    byProduct.get(product).add(level);
  }

  return {
    accountWide: false,
    products: [...byProduct].map(([product, levels]) => ({
      product,
      label: productLabel(product),
      levels: LEVEL_ORDER.filter((level) => levels.has(level)),
    })),
  };
}

// The grant as capability lines grouped by product — what the consent card renders. An account-wide
// or empty grant answers no groups; the card says those in words, because "everything" and "nothing"
// are sentences, not lists.
export function capabilityGroups(scope) {
  return readScope(scope).products.map((group) => ({
    product: group.product,
    label: group.label,
    lines: group.levels.map((level) => ({
      level,
      glyph: LEVELS[level].glyph,
      label: `${LEVELS[level].verb} your ${group.label}`,
    })),
  }));
}

// Everything the consent card draws, in one read, because its three faces are one decision and
// splitting them is how they went wrong. `reach` is 'everything' for the legacy account-wide grant,
// 'nothing' for a scope this build cannot read, and 'listed' when there are real lines — and the
// first two draw the SAME zero capability lines, so a card branching on "are there any lines?"
// called every unreadable scope "Everything in your account". That is the one direction of this
// mistake that can hurt somebody: telling a person a token holds nothing when it holds everything
// is confusing, the other way round is the lie.
//
// `canDelete` is answered here for the same reason. The account-wide grant renders no delete LINE
// and can delete in every product there is, so a card reading the answer off its own rendered list
// handed the widest grant in the system the sentence written for the narrowest.
export function consentSummary(scope) {
  const { accountWide, products } = readScope(scope);
  if (accountWide) return { reach: 'everything', groups: [], canDelete: true };
  if (products.length === 0) return { reach: 'nothing', groups: [], canDelete: false };
  return {
    reach: 'listed',
    groups: capabilityGroups(scope),
    canDelete: products.some((group) => group.levels.includes('delete')),
  };
}

// The one line the settings "Connected tools" row shows under a tool's name, so a grant approved
// months ago is still legible. A grant that can delete says so — the level is never shortened away.
export function summarizeScope(scope) {
  const { accountWide, products } = readScope(scope);
  if (accountWide) return 'Everything in your account';
  if (products.length === 0) return 'Nothing — this grant reaches no product';
  return products.map((group) => `${group.label}: ${group.levels.join(', ')}`).join(' · ');
}
