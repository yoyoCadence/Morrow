import { useEffect, useState } from 'react';

/**
 * The dashboard's pages. Paths, not hashes: the API serves index.html for
 * any path outside /api/, so every page can be bookmarked and reloaded.
 */
export type Route =
  | { readonly page: 'system' }
  /** The latest snapshot of every pool. */
  | { readonly page: 'market' }
  /** Events, optionally of one subject, with the latest observations and quarantined fields. */
  | { readonly page: 'evidence'; readonly subject: string | null }
  | { readonly page: 'observation'; readonly id: string };

const OBSERVATION_PATH = /^\/evidence\/observations\/([1-9]\d{0,18})\/?$/;

/** The page for a location. Anything unknown is the system page. */
export function parseRoute(pathname: string, search: string): Route {
  const observation = OBSERVATION_PATH.exec(pathname);
  if (observation?.[1]) return { page: 'observation', id: observation[1] };
  if (pathname === '/market' || pathname === '/market/') return { page: 'market' };
  if (pathname === '/evidence' || pathname === '/evidence/') {
    const subject = new URLSearchParams(search).get('subject');
    return { page: 'evidence', subject: subject === null || subject === '' ? null : subject };
  }
  return { page: 'system' };
}

/** The path of a page, the inverse of `parseRoute`. */
export function routePath(route: Route): string {
  switch (route.page) {
    case 'system':
      return '/';
    case 'market':
      return '/market';
    case 'evidence':
      return route.subject === null ? '/evidence' : `/evidence?subject=${encodeURIComponent(route.subject)}`;
    case 'observation':
      return `/evidence/observations/${route.id}`;
  }
}

const NAVIGATED = 'morrow:navigate';

/** Goes to a page without reloading, and lets the back button return. */
export function navigate(route: Route): void {
  const path = routePath(route);
  if (`${window.location.pathname}${window.location.search}` === path) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATED));
  window.scrollTo(0, 0);
}

const currentRoute = (): Route => parseRoute(window.location.pathname, window.location.search);

/** The current page, following links inside the dashboard and the browser's back and forward. */
export function useRoute(): Route {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const update = (): void => setRoute(currentRoute());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATED, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATED, update);
    };
  }, []);
  return route;
}
