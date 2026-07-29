/**
 * Cross-context UUID v4 generator.
 *
 * `crypto.randomUUID()` is **secure-context only** (HTTPS or localhost). When
 * the SPA is served over plain HTTP — e.g. an AKS LoadBalancer IP without TLS
 * fronting it — the browser leaves it `undefined` and any caller throws
 * `crypto.randomUUID is not a function`. The axios request interceptor used
 * to do this on every API call, which silently broke login on the LoadBalancer
 * deployment.
 *
 * Strategy:
 *   1. Native `crypto.randomUUID()` when available (HTTPS / localhost).
 *   2. `crypto.getRandomValues()` fallback — works in non-secure contexts too,
 *      output is RFC 4122 v4-shaped.
 *   3. `Math.random` last resort for ancient runtimes.
 *
 * The X-Request-Id / toast-id / form-id use cases are tracing & DOM
 * uniqueness, not security — so the fallback is fit for purpose.
 */
export const uuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};
