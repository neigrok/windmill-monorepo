import React from 'react';
import './styles/showcase.css';
import {
  Icon,
  Button,
  IconButton,
  Badge,
  Tag,
  Avatar,
  Card,
  Input,
  Select,
  Checkbox,
  Radio,
  Switch,
  Tooltip,
  Dialog,
  Toast,
  Tabs,
} from './design-system/index.js';
import { SkillNode } from './products/roadmap/ui/tree/SkillNode.jsx';
import { SkillConnector } from './products/roadmap/ui/tree/SkillConnector.jsx';
import { ProgressBar } from './products/roadmap/ui/tree/ProgressBar.jsx';
import { GalleryCard } from './products/roadmap/share/GalleryCard.jsx';
import { ShareStats } from './products/roadmap/share/ShareStats.js';

/* ------------------------------------------------------------------ *
 * Skill-tree demo — the signature Windmill metaphor.
 * Nodes are positioned by their circle-center (cx, cy); a SkillNode of
 * size S has its circle center at (S/2 + 20, S/2 + 12) from its top-left,
 * so we back that out to place the absolute node and align connectors.
 * ------------------------------------------------------------------ */
const NODE_SIZE = 56;

const TREE_NODES = [
  { id: 'root', cx: 320, cy: 240, state: 'complete', kind: 'terracotta', label: 'Plan & measure', icon: 'ruler' },
  { id: 'furniture', cx: 150, cy: 135, state: 'available', kind: 'olive', label: 'Pick furniture', icon: 'sofa' },
  { id: 'palette', cx: 165, cy: 360, state: 'active', kind: 'plum', label: 'Choose palette', icon: 'palette' },
  { id: 'plants', cx: 495, cy: 150, state: 'available', kind: 'sky', label: 'Add plants', icon: 'sprout' },
  { id: 'shelves', cx: 515, cy: 350, state: 'locked', kind: 'gold', label: 'Style shelves', icon: 'lock' },
];

// [from, to, active?] — a branch is "grown" (active) once its parent is complete.
const TREE_EDGES = [
  ['root', 'furniture', true],
  ['root', 'palette', true],
  ['root', 'plants', true],
  ['plants', 'shelves', false],
];

function nodeCenter(n) {
  return { x: n.cx, y: n.cy };
}
function nodeTopLeft(n) {
  // Flat canon node: circle center sits at (size/2 + 20, size/2) from the wrapper's
  // top-left (no stem gap above), so we back that out to align with the connector.
  return { left: n.cx - NODE_SIZE / 2 - 20, top: n.cy - NODE_SIZE / 2 };
}

function SkillTreeDemo() {
  const byId = Object.fromEntries(TREE_NODES.map((n) => [n.id, n]));
  return (
    <div className="wm-tree-canvas">
      <svg className="wm-tree-svg" viewBox="0 0 640 460" preserveAspectRatio="xMidYMid meet">
        {TREE_EDGES.map(([from, to, active]) => (
          <SkillConnector
            key={`${from}-${to}`}
            from={nodeCenter(byId[from])}
            to={nodeCenter(byId[to])}
            active={active}
            seedKey={`${from}-${to}`}
          />
        ))}
      </svg>
      {TREE_NODES.map((n) => (
        <div key={n.id} className="wm-tree-node" style={nodeTopLeft(n)}>
          <SkillNode
            label={n.label}
            state={n.state}
            kind={n.kind}
            size={NODE_SIZE}
            icon={<Icon name={n.icon} size={Math.round(NODE_SIZE * 0.4)} color="currentColor" />}
          />
        </div>
      ))}
    </div>
  );
}

/* ---- Foundation specimens ---- */
const BRAND_SWATCHES = [
  { name: 'terracotta', hex: '#BC6C42', var: '--accent-terracotta-500' },
  { name: 'olive', hex: '#7D8C43', var: '--accent-olive-500' },
  { name: 'gold', hex: '#C4972F', var: '--accent-gold-500' },
  { name: 'brick', hex: '#A84E35', var: '--accent-brick-500' },
  { name: 'sky', hex: '#5F8494', var: '--accent-sky-500' },
];
const NEUTRAL_SWATCHES = [
  { name: 'canvas 50', hex: '#F9F5EB', var: '--neutral-50' },
  { name: 'sand 100', hex: '#F1EADA', var: '--neutral-100' },
  { name: 'sand 200', hex: '#E5D9C0', var: '--neutral-200' },
  { name: 'clay 400', hex: '#B29F7B', var: '--neutral-400' },
  { name: 'bark 600', hex: '#6F5F45', var: '--neutral-600' },
  { name: 'ink 900', hex: '#211B13', var: '--neutral-900' },
];
const TYPE_SPECIMENS = [
  { tag: 'display 4xl', size: 'var(--text-4xl)', font: 'var(--font-display)', weight: 800, text: 'Any goal, as a skill tree' },
  { tag: 'display 2xl', size: 'var(--text-2xl)', font: 'var(--font-display)', weight: 700, text: 'Unlock the next step' },
  { tag: 'body lg', size: 'var(--text-lg)', font: 'var(--font-body)', weight: 400, text: 'Finishing one step unlocks whatever comes next.' },
  { tag: 'body base', size: 'var(--text-base)', font: 'var(--font-body)', weight: 400, text: 'A calm, capable tool first — a game second.' },
  { tag: 'mono sm', size: 'var(--text-sm)', font: 'var(--font-mono)', weight: 500, text: 'XP 1,240 · STEP-04F' },
];

/* ---- Share identity demo (X2) — one fake RenderModel, reused across cards ---- */
const SHARE_DEMO_MODEL = {
  nodes: [
    { id: 'root', color: 'terracotta', x: 300, y: 210, state: 'complete', emphasis: 1 },
    { id: 'a', color: 'olive', x: 150, y: 120, state: 'complete', emphasis: 0 },
    { id: 'b', color: 'terracotta', x: 150, y: 300, state: 'complete', emphasis: 0 },
    { id: 'c', color: 'gold', x: 450, y: 120, state: 'available', emphasis: 0 },
    { id: 'd', color: 'plum', x: 450, y: 300, state: 'available', emphasis: 0 },
    { id: 'a1', color: 'olive', x: 60, y: 60, state: 'complete', emphasis: 0 },
    { id: 'a2', color: 'sky', x: 60, y: 180, state: 'locked', emphasis: 0 },
    { id: 'b1', color: 'brick', x: 60, y: 360, state: 'available', emphasis: 0 },
    { id: 'c1', color: 'gold', x: 540, y: 60, state: 'locked', emphasis: 0 },
    { id: 'd1', color: 'plum', x: 540, y: 300, state: 'locked', emphasis: 0 },
    { id: 'd2', color: 'brick', x: 480, y: 400, state: 'locked', emphasis: 0 },
  ],
  edges: [
    { from: 'root', to: 'a', kind: 'trunk' },
    { from: 'root', to: 'b', kind: 'trunk' },
    { from: 'root', to: 'c', kind: 'trunk' },
    { from: 'root', to: 'd', kind: 'trunk' },
    { from: 'a', to: 'a1', kind: 'trunk' },
    { from: 'a', to: 'a2', kind: 'trunk' },
    { from: 'b', to: 'b1', kind: 'trunk' },
    { from: 'c', to: 'c1', kind: 'trunk' },
    { from: 'd', to: 'd1', kind: 'trunk' },
    { from: 'd', to: 'd2', kind: 'trunk' },
  ],
  bounds: { minX: 40, minY: 40, maxX: 560, maxY: 420 },
};

const SHARE_CARDS = [
  { title: 'Learn to sail', theme: 'light', dominantKind: 'terracotta', stats: new ShareStats({ done: 8, total: 17, dominantKind: 'terracotta' }), author: 'Maren K.', updatedAgo: '2d ago' },
  { title: 'Ship the redesign', theme: 'dark', dominantKind: 'plum', stats: new ShareStats({ done: 12, total: 20, dominantKind: 'plum' }), author: 'Sam Gold', updatedAgo: '5h ago' },
  { title: 'Marathon base', theme: 'light', dominantKind: 'olive', stats: new ShareStats({ done: 4, total: 24, dominantKind: 'olive' }), author: 'Ada Vale', updatedAgo: '1w ago' },
  { title: 'Home studio', theme: 'dark', dominantKind: 'gold', stats: new ShareStats({ done: 19, total: 19, dominantKind: 'gold' }), author: 'Ravi Okon', updatedAgo: 'just now' },
];

function Section({ title, meta, children }) {
  return (
    <section className="wm-section">
      <div className="wm-section-head">
        <h2>{title}</h2>
        {meta && <span>{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="wm-label">{label}</div>
      {children}
    </div>
  );
}

export default function Showcase() {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [showToast, setShowToast] = React.useState(true);
  const [switchOn, setSwitchOn] = React.useState(true);
  const [checked, setChecked] = React.useState(true);
  const [radio, setRadio] = React.useState('solo');
  const [tab, setTab] = React.useState('tree');
  const [selectVal, setSelectVal] = React.useState('room');
  const [inputVal, setInputVal] = React.useState('');
  const [tagOpen, setTagOpen] = React.useState(true);

  return (
    <div className="wm-page">
      {/* ---- Top bar ---- */}
      <header className="wm-topbar">
        <span className="wm-wordmark">
          <span className="wm-mark"><Icon name="git-branch-plus" size={26} /></span>
          Windmill
        </span>
        <div className="wm-row wm-row-tight">
          <Button variant="ghost" size="sm">Docs</Button>
          <Button variant="primary" size="sm" icon={<Icon name="sparkles" size={16} />}>
            Get started
          </Button>
        </div>
      </header>

      <main className="wm-main">
        {/* ---- Hero ---- */}
        <div className="wm-hero">
          <span className="wm-eyebrow">Now in public beta</span>
          <h1>Any goal, as a skill tree.</h1>
          <p>
            Windmill renders any roadmap — a product launch, a fitness goal, a room
            makeover — as an RPG skill tree. Steps are nodes, dependencies are branches,
            and finishing one step unlocks whatever comes next.
          </p>
          <div className="wm-row" style={{ marginTop: 'var(--space-6)' }}>
            <Button variant="primary" size="lg" icon={<Icon name="sprout" size={18} />}>
              Plant your first tree
            </Button>
            <Button variant="secondary" size="lg" icon={<Icon name="play" size={18} />}>
              Watch demo
            </Button>
          </div>
        </div>

        {/* ---- Signature: skill tree ---- */}
        <Section title="Skill tree" meta="SkillNode · SkillConnector · ProgressBar">
          <div className="wm-stack" style={{ gap: 'var(--space-6)' }}>
            <SkillTreeDemo />
            <Card style={{ maxWidth: 640, margin: '0 auto', width: '100%' }}>
              <div className="wm-row" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
                <div className="wm-row wm-row-tight">
                  <Badge tone="brand" dot>Living room</Badge>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                    3 / 5 steps
                  </span>
                </div>
                <div className="wm-row wm-row-tight">
                  <Avatar name="Sam Gold" size={28} />
                  <Avatar name="Ada Vale" size={28} />
                  <Avatar name="Ravi Okon" size={28} />
                </div>
              </div>
              <ProgressBar value={60} label="Branch XP" />
            </Card>
          </div>
        </Section>

        {/* ---- Share identity ---- */}
        <Section title="Share identity" meta="GalleryCard · dominant kind · light + dark">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-5)' }}>
            {SHARE_CARDS.map((c) => (
              <GalleryCard key={c.title} model={SHARE_DEMO_MODEL} {...c} />
            ))}
          </div>
        </Section>

        {/* ---- Buttons ---- */}
        <Section title="Buttons" meta="4 variants · 3 sizes · soft 0.97 press">
          <div className="wm-stack">
            <Field label="Variants">
              <div className="wm-row">
                <Button variant="primary">Get started</Button>
                <Button variant="secondary" icon={<Icon name="plus" size={16} />}>New step</Button>
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger" icon={<Icon name="trash-2" size={16} />}>Delete step</Button>
                <Button variant="primary" disabled>Disabled</Button>
              </div>
            </Field>
            <Field label="Sizes">
              <div className="wm-row">
                <Button variant="primary" size="sm">Small</Button>
                <Button variant="primary" size="md">Medium</Button>
                <Button variant="primary" size="lg">Large</Button>
              </div>
            </Field>
          </div>
        </Section>

        {/* ---- Core bits ---- */}
        <Section title="Core" meta="IconButton · Badge · Tag · Avatar">
          <div className="wm-grid">
            <Card>
              <div className="wm-label">Icon buttons</div>
              <div className="wm-row wm-row-tight">
                <IconButton label="Add" icon={<Icon name="plus" size={18} />} variant="filled" />
                <IconButton label="Edit" icon={<Icon name="pencil" size={18} />} />
                <IconButton label="Favorite" icon={<Icon name="star" size={18} />} active />
                <IconButton label="More" icon={<Icon name="ellipsis" size={18} />} />
              </div>
            </Card>
            <Card>
              <div className="wm-label">Badges</div>
              <div className="wm-row wm-row-tight">
                <Badge tone="neutral">Locked</Badge>
                <Badge tone="brand" dot>Complete</Badge>
                <Badge tone="success" dot>Available</Badge>
                <Badge tone="warning" dot>Active</Badge>
                <Badge tone="danger">Blocked</Badge>
              </div>
            </Card>
            <Card>
              <div className="wm-label">Tags</div>
              <div className="wm-row wm-row-tight">
                <Tag selected>Home</Tag>
                <Tag>Fitness</Tag>
                {tagOpen && <Tag onRemove={() => setTagOpen(false)}>Learning</Tag>}
              </div>
            </Card>
            <Card>
              <div className="wm-label">Avatars</div>
              <div className="wm-row wm-row-tight">
                <Avatar name="Sam Gold" size={40} />
                <Avatar name="Ada Vale" size={40} />
                <Avatar name="Ravi Okon" size={40} />
                <Avatar name="Mira Sol" size={40} />
              </div>
            </Card>
          </div>
        </Section>

        {/* ---- Cards ---- */}
        <Section title="Cards" meta="24px radius · lift on hover">
          <div className="wm-grid">
            <Card hoverable>
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                <span style={{ color: 'var(--color-success)' }}><Icon name="sprout" size={22} /></span>
                <strong style={{ fontFamily: 'var(--font-display)' }}>Grow anything</strong>
              </div>
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-sm)' }}>
                A roadmap can be personal growth, learning a skill, or a daily project. Hover me — I lift 2px.
              </p>
            </Card>
            <Card hoverable>
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                <span style={{ color: 'var(--color-brand)' }}><Icon name="users" size={22} /></span>
                <strong style={{ fontFamily: 'var(--font-display)' }}>Solo or shared</strong>
              </div>
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-sm)' }}>
                Track a tree on your own or invite others to climb it with you.
              </p>
            </Card>
            <Card hoverable>
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                <span style={{ color: 'var(--accent-gold-600)' }}><Icon name="zap" size={22} /></span>
                <strong style={{ fontFamily: 'var(--font-display)' }}>Earn XP</strong>
              </div>
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-sm)' }}>
                Every finished step ripens a fruit and lights up the branch ahead.
              </p>
            </Card>
          </div>
        </Section>

        {/* ---- Forms ---- */}
        <Section title="Forms" meta="Input · Select · Checkbox · Radio · Switch">
          <div className="wm-grid" style={{ alignItems: 'start' }}>
            <div className="wm-stack">
              <Input
                label="Roadmap name"
                placeholder="e.g. Living room makeover"
                icon={<Icon name="map" size={16} />}
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
              />
              <Input
                label="Invite email"
                placeholder="name@team.com"
                error="Enter a valid email address"
                value=""
                onChange={() => {}}
              />
            </div>
            <div className="wm-stack">
              <Select
                label="Roadmap type"
                value={selectVal}
                onChange={setSelectVal}
                options={[
                  { value: 'room', label: 'Room makeover' },
                  { value: 'fitness', label: 'Fitness goal' },
                  { value: 'launch', label: 'Product launch' },
                  { value: 'learning', label: 'Learning path' },
                ]}
              />
              <Field label="Toggles">
                <div className="wm-stack" style={{ gap: 'var(--space-3)' }}>
                  <Checkbox label="Notify me on unlocks" checked={checked} onChange={setChecked} />
                  <Switch label="Public tree" checked={switchOn} onChange={setSwitchOn} />
                </div>
              </Field>
            </div>
            <Field label="Track this as">
              <div className="wm-stack" style={{ gap: 'var(--space-3)' }}>
                <Radio label="Solo" checked={radio === 'solo'} onChange={() => setRadio('solo')} />
                <Radio label="Shared with a team" checked={radio === 'shared'} onChange={() => setRadio('shared')} />
                <Radio label="Public template" checked={radio === 'public'} onChange={() => setRadio('public')} />
              </div>
            </Field>
          </div>
        </Section>

        {/* ---- Navigation + feedback ---- */}
        <Section title="Navigation & feedback" meta="Tabs · Tooltip · Dialog · Toast">
          <div className="wm-stack" style={{ gap: 'var(--space-6)' }}>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'tree', label: 'Tree' },
                { value: 'list', label: 'List' },
                { value: 'timeline', label: 'Timeline' },
              ]}
            />
            <div className="wm-row">
              <Tooltip label="This unlocks 2 more steps up the tree">
                <Button variant="secondary" icon={<Icon name="info" size={16} />}>Hover for tooltip</Button>
              </Tooltip>
              <Button variant="primary" onClick={() => setDialogOpen(true)} icon={<Icon name="flag" size={16} />}>
                Open dialog
              </Button>
              {showToast && (
                <Toast tone="success" onClose={() => setShowToast(false)}>
                  Step unlocked: Add plants.
                </Toast>
              )}
              {!showToast && (
                <Button variant="ghost" size="sm" onClick={() => setShowToast(true)}>Reset toast</Button>
              )}
            </div>
          </div>
        </Section>

        {/* ---- Foundations ---- */}
        <Section title="Foundations" meta="Warm Tuscan earth palette · rounded type">
          <div className="wm-stack" style={{ gap: 'var(--space-8)' }}>
            <div>
              <div className="wm-label">Brand & semantic</div>
              <div className="wm-swatches">
                {BRAND_SWATCHES.map((s) => (
                  <div className="wm-swatch" key={s.name}>
                    <div className="wm-swatch-chip" style={{ background: `var(${s.var})` }} />
                    <div className="wm-swatch-meta">
                      <div className="wm-swatch-name">{s.name}</div>
                      <div className="wm-swatch-hex">{s.hex}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="wm-label">Neutrals (warm sand, never cold gray)</div>
              <div className="wm-swatches">
                {NEUTRAL_SWATCHES.map((s) => (
                  <div className="wm-swatch" key={s.name}>
                    <div className="wm-swatch-chip" style={{ background: `var(${s.var})` }} />
                    <div className="wm-swatch-meta">
                      <div className="wm-swatch-name">{s.name}</div>
                      <div className="wm-swatch-hex">{s.hex}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="wm-label">Type</div>
              <Card>
                {TYPE_SPECIMENS.map((t) => (
                  <div className="wm-type-row" key={t.tag}>
                    <span className="wm-type-tag">{t.tag}</span>
                    <span style={{ fontFamily: t.font, fontSize: t.size, fontWeight: t.weight, color: 'var(--text-primary)' }}>
                      {t.text}
                    </span>
                  </div>
                ))}
              </Card>
            </div>
          </div>
        </Section>

        <p className="wm-footnote">
          Built with the <strong>Windmill Design System</strong> — tokens in{' '}
          <code>src/styles/tokens/</code>, components in <code>src/design-system/</code>.
          Colors, type, and voice are a proposed <strong>v1</strong> direction (the system was
          authored without the real Windmill repo or brand assets) — swap in real tokens when available.
        </p>
      </main>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Unlock this step?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Not yet</Button>
            <Button variant="primary" onClick={() => setDialogOpen(false)}>Unlock step</Button>
          </>
        }
      >
        Marking “Plan &amp; measure” complete will unlock 3 more steps up the tree. You can
        always lock it again later.
      </Dialog>
    </div>
  );
}
