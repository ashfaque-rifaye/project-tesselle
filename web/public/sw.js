// Project Tesselle service worker: receives photos/videos shared from the phone's share sheet
// (e.g. Ray-Ban Meta captures in the Meta AI app or the gallery) and hands them to the /share page.
const SHARE_CACHE = "tesselle-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(
      (async () => {
        const form = await event.request.formData();
        const files = form.getAll("media").filter((f) => f && typeof f !== "string");
        const cache = await caches.open(SHARE_CACHE);
        await Promise.all((await cache.keys()).map((k) => cache.delete(k)));
        let i = 0;
        for (const f of files) {
          await cache.put(`/shared/${i}`, new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream", "X-Name": encodeURIComponent(f.name || `capture-${i}`) } }));
          i++;
        }
        const note = [form.get("title"), form.get("text"), form.get("url")].filter(Boolean).join(" ");
        await cache.put("/shared/meta", new Response(JSON.stringify({ count: i, note }), { headers: { "Content-Type": "application/json" } }));
        return Response.redirect(`/share?n=${i}`, 303);
      })(),
    );
  }
});
