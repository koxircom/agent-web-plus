const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DESKTOP_IMAGE = /^[0-9a-f]{64}$/;

/** Resolve only identities handled by the bridge's session-scoped image APIs. */
export function codexImagePath(thread: string | null, upload: string | null, desktop: string | null): string | null {
  if (!thread || !UUID.test(thread) || Boolean(upload) === Boolean(desktop)) return null;
  if (upload && UUID.test(upload)) return `/api/sessions/${thread}/uploads/${upload}/preview?variant=original`;
  if (desktop && DESKTOP_IMAGE.test(desktop)) return `/api/sessions/${thread}/desktop-images/${desktop}`;
  return null;
}
