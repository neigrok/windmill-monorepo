import React, { Suspense, lazy } from 'react';

// Both routes are lazy so the entry chunk is just React + the router: the
// heavy WebGL skill-tree route and the design-system showcase each load
// on demand, and the first paint below shows instantly while they stream in.
const SkillTreeView = lazy(() => import('./skilltree').then((m) => ({ default: m.SkillTreeView })));
const Showcase = lazy(() => import('./Showcase.jsx'));

function useHashRoute() {
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

function RouteFallback() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface-canvas)',
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-display)',
        fontWeight: 800,
        fontSize: 'var(--text-xl)',
        letterSpacing: 'var(--tracking-wide)',
      }}
    >
      Windmill
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const View = route === '#/showcase' ? Showcase : SkillTreeView;
  return (
    <Suspense fallback={<RouteFallback />}>
      <View />
    </Suspense>
  );
}
