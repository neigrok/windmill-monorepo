import React from 'react';
import { SkillTreeView } from './skilltree';
import Showcase from './Showcase.jsx';

function useHashRoute() {
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export default function App() {
  const route = useHashRoute();
  if (route === '#/showcase') return <Showcase />;
  return <SkillTreeView />;
}
