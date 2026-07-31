/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Everything a teacher needs is served from this cache, so the app keeps
 * working when the wifi drops: the pages, the JavaScript chunks (including the
 * spreadsheet reader, which is loaded on demand), and the blank template.
 *
 * Nothing here talks to a third party — the only requests we ever make are for
 * files from this origin, and workbooks are read in the tab, never sent.
 */
import { base, build, files, prerendered, version } from "$service-worker";

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `sped-services-${version}`;

/** Hashed build chunks, static files, and every prerendered page. */
const PRECACHE = [...build, ...files, ...prerendered];
const PRECACHED = new Set(PRECACHE);

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        await cache.addAll(PRECACHE);
      } catch {
        // One bad response would otherwise abandon the whole install and leave
        // the app with no offline copy at all. Save whatever we can instead.
        await Promise.allSettled(PRECACHE.map((path) => cache.add(path)));
      }
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  // `vite dev` serves modules from memory with hot updates; caching there would
  // only hand stale code back to whoever is working on the app.
  if (import.meta.env.DEV) return;

  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Only this origin is ever cached or intercepted; nothing else is requested.
  if (url.origin !== sw.location.origin) return;

  event.respondWith(respond(request, url));
});

/**
 * A cached page that arrived via a redirect cannot be handed straight back to a
 * navigation, so strip the redirect by copying it.
 */
function replayable(response: Response): Response {
  if (!response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function respond(request: Request, url: URL): Promise<Response> {
  const cache = await caches.open(CACHE);

  // Precached files are content-hashed or versioned with this worker, so the
  // cached copy is always the right one and we can skip the network entirely.
  if (PRECACHED.has(url.pathname)) {
    const hit = await cache.match(url.pathname);
    if (hit) return replayable(hit);
  }

  try {
    const response = await fetch(request);
    if (response.status === 200 && response.type === "basic") {
      void cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const hit =
      (await cache.match(request)) ??
      (await cache.match(url.pathname)) ??
      // A navigation to a path we have not seen still gets a usable shell.
      (request.mode === "navigate"
        ? await cache.match(`${base}/`.replace(/\/+$/, "/"))
        : undefined);
    if (hit) return replayable(hit);
    throw error;
  }
}
