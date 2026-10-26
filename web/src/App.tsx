import { useEffect, useState } from 'react';
import { SessionList } from './components/SessionList';
import { NewSession } from './components/NewSession';
import { SessionView } from './components/SessionView';
import { DiffView } from './components/DiffView';

export type Route = { name: 'list' } | { name: 'new' } | { name: 'session'; id: string } | { name: 'diff'; id: string };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 's' && parts[1]) return parts[2] === 'diff' ? { name: 'diff', id: parts[1] } : { name: 'session', id: parts[1] };
  return { name: 'list' };
}

export function navigate(hash: string) {
  location.hash = hash;
}

export function App() {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  switch (route.name) {
    case 'new':
      return <NewSession />;
    case 'session':
      return <SessionView key={route.id} id={route.id} />;
    case 'diff':
      return <DiffView key={route.id} id={route.id} />;
    default:
      return <SessionList />;
  }
}
