// The address this deployment answers to, as it should be shown and registered with other
// services (webhook callbacks, the widget snippet). NEXT_PUBLIC_SITE_URL is set at build time to the
// canonical host (halo.vircle.tech), so a person who happens to open the app through an older alias
// (crm.vircle.tech) is still shown the canonical addresses. Without it, the browser's own address.
// Sign-in and password-reset redirects deliberately do NOT use this: they must stay on the host the
// person started on, because the sign-in cookies belong to that host.

/** `https://halo.vircle.tech` (no trailing slash), or '' when it cannot be known (server render without the setting). */
export function publicOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  return typeof window !== 'undefined' ? window.location.origin : ''
}
