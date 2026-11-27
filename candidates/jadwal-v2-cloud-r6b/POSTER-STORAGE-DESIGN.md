# Poster storage proposal (not provisioned)

Candidate bucket: `sipapua-jadwal-posters`. Posters are optional; use existing original `browser/poster-fallback.svg` when absent/unavailable. Store object path only, not image bytes in schedule rows. Current poster preview is not persistence.

Since worship posters are intended for public member display, the proposal is public-read, but public URLs are fetchable by anyone. Do not allow public listing or browser insert/update/delete. Only trusted Edge code may upload/delete after admin authorization. If confidentiality is required, private bucket + signed URLs is possible but adds expiry/cache complexity.

Validate server-side while streaming: max 2 MiB; JPEG/PNG/WebP signatures and actual decoding; reject SVG/HTML/polyglots, malformed files, MIME mismatch and unsafe dimensions. Generate random UUID paths server-side, never accept object paths from browser, use no-overwrite uploads. On schedule save failure, best-effort delete only the new object and record orphan cleanup status; do not remove old poster until schedule revision succeeds. No transforms or paid features.

Storage quota, bandwidth, and exact project plan limits require a current read-only check; quota exhaustion/overage does not guarantee Rp0. Supabase docs currently state a 50 MB global Free file cap, which may change. No bucket, policy, object, or upload was created. Permanent storage remains blocked pending Owner choice of public/private, quota/cost review, policy review and isolated upload/replacement/orphan tests.
