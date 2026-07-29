/**
 * Single source of truth for runtime configuration.
 *
 * Reads Vite env vars, applies defaults, and exposes a typed object so the
 * rest of the app never touches `import.meta.env` directly. Add new flags
 * here so they get types and defaults instead of leaking through the codebase.
 */

const truthy = (v: string | undefined, fallback = false): boolean => {
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
};

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  app: {
    name:    import.meta.env.VITE_APP_NAME    ?? 'Blinkit',
    version: import.meta.env.VITE_APP_VERSION ?? '0.1.0',
    env:     import.meta.env.VITE_APP_ENV     ?? 'development',
  },
  api: {
    // The frontend talks to the API gateway only — never directly to a service.
    // Empty string = same-origin: in production the bundle is served by the
    // frontend nginx, which reverse-proxies /api/** into the api-gateway. A
    // host fallback like "http://localhost:8080" would silently bake the dev
    // address into the prod bundle if VITE_API_BASE_URL isn't set at build time.
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
    timeout: num(import.meta.env.VITE_API_TIMEOUT, 15_000),
  },
  auth: {
    storageKey: import.meta.env.VITE_AUTH_STORAGE_KEY ?? 'blinkit.auth',
  },
  features: {
    threeD:    truthy(import.meta.env.VITE_ENABLE_3D,        true),
    particles: truthy(import.meta.env.VITE_ENABLE_PARTICLES, true),
    devtools:  truthy(import.meta.env.VITE_ENABLE_DEVTOOLS,  true),
  },
} as const;

export type AppConfig = typeof config;
