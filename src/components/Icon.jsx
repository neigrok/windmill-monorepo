import React from 'react';
import {
  GitBranchPlus,
  Sparkles,
  Sprout,
  Play,
  Ruler,
  Sofa,
  Palette,
  Lock,
  Plus,
  Trash2,
  Pencil,
  Star,
  MoreHorizontal,
  Users,
  Zap,
  Map,
  Info,
  Flag,
  Check,
  ZoomIn,
  ZoomOut,
  Maximize,
  X,
  ExternalLink,
} from 'lucide-react';

/**
 * Icon — thin wrapper over Lucide (the design system's chosen line-icon set).
 *
 * The design system references icons by kebab/lowercase name (e.g. "chevron-down",
 * "sofa") and passes them into components as `icon={<Icon name="..." />}`. We keep
 * that name-based API but back it with an explicit registry of named imports rather
 * than pulling the whole icon set — that keeps the dev server and bundle lean. Add a
 * new icon by importing it above and registering its kebab name here.
 */
const REGISTRY = {
  'git-branch-plus': GitBranchPlus,
  sparkles: Sparkles,
  sprout: Sprout,
  play: Play,
  ruler: Ruler,
  sofa: Sofa,
  palette: Palette,
  lock: Lock,
  plus: Plus,
  'trash-2': Trash2,
  pencil: Pencil,
  star: Star,
  ellipsis: MoreHorizontal,
  'more-horizontal': MoreHorizontal,
  users: Users,
  zap: Zap,
  map: Map,
  info: Info,
  flag: Flag,
  check: Check,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  maximize: Maximize,
  x: X,
  'external-link': ExternalLink,
};

export function Icon({ name, size = 16, strokeWidth = 2, color = 'currentColor', style }) {
  const Cmp = REGISTRY[name];
  if (!Cmp) {
    if (import.meta.env?.DEV) console.warn(`[Icon] Unregistered icon: "${name}" — add it to Icon.jsx`);
    return null;
  }
  return <Cmp size={size} strokeWidth={strokeWidth} color={color} style={style} />;
}

export default Icon;
