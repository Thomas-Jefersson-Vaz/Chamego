# Chamego API contract — protocol 2

HTTP base: `https://YOUR_HOST/api`. Socket.IO: same HTTPS host, path `/ws`. Protected routes require `Authorization: Bearer TOKEN`. Wire IDs are UUIDs, date/times are ISO 8601 strings, and booleans are JSON booleans. Password hashes and FCM tokens are never returned in profiles.

## Authentication and membership

| Method and path | Body / response |
| --- | --- |
| `POST /auth/register` | `{name,email,password}` → 201 `{user,token}` |
| `POST /auth/login` | `{email,password}` → `{user,token}` |
| `GET /users/me` | `{user}` with current `couple_id` |
| `GET /couples/me` | `{couple,partner}`, nullable |
| `POST /couples/invite` | `{renew?:boolean}` → `{couple,partner}`; creates/renews a seven-day invitation |
| `POST /couples/pair` | `{code}` → `{couple,partner}` |
| `POST /couples/unpair` | `{}` → `{status:"success"}` |
| `POST /users/relationship-type` | `{relationship_type}` |
| `POST /couples/start-date` | `{start_date}` |
| `POST /users/fcm-token` | `{fcm_token}`; transfers unique token ownership |
| `DELETE /users/fcm-token` | `{fcm_token}`; revokes only that token, preserving newer registrations |

Registration requires at least eight password characters and at most 72 UTF-8 bytes. HS256 JWTs expire after seven days. Restore the cached account identified by the JWT; on HTTP 401 require login while preserving pending writes. Relationship values: `Monogâmico(a)`, `Bi-amoroso(a)`, `Poliamoroso(a)`.

Pairing is atomic; full couples cannot accept another member. Unpairing revokes membership while preserving history. Invitation codes always come from the server; clients must never fabricate successful sessions/pairing.

## Entity writes

| Sync entity | Fields |
| --- | --- |
| `chamegos` | `id,couple_id,text,type,created_at`; authenticated sender |
| `outings` | `id,couple_id,title,location,date,category,cost,status,rating,notify_option,is_deleted` |
| `memories` | `id,couple_id,title,date,description,mood,photo_urls,is_deleted` |
| `gifts` | `id,couple_id,title,type,store_url,price,occasion,is_deleted`; authenticated creator on insert |
| `special_dates` | `id,couple_id,title,date,repeat_option,notify_option,is_deleted` |

Titles/locations: 255 characters; category/mood/occasion: 100; message/description: 4,000. Amounts: finite, non-negative, at most 99,999,999.99; ratings: integer 0–5. Gift types: `wish`, `secret`, `given`. Outing status: `planned`, `idea`, `done`. Recurrence: `none`, `monthly`, `yearly`. Notify options: `none`, `day`, `1day_before`, `1week_before`. Photos: array of at most 20 HTTPS URLs. Photo upload/password reset are unsupported.

Non-message REST paths are `/outings`, `/memories`, `/gifts`, `/special-dates`: GET/POST at the base, PUT/DELETE at `/:id`. GET accepts `limit` (1–500, default 100), `offset` (non-negative, default 0). POST returns 201 on insert or 200 on authorized update; PUT is partial, DELETE stores a tombstone. Server update timestamps are authoritative. The shipped client writes through the outbox and `/sync`.

Compatibility message route: `POST /notifications/emote` with `{id,couple_id,emote,text,timestamp}` → `{status:"success",chamego}`. Reuse the same client UUID for retries/sync. Caller-supplied sender metadata does not determine identity. Messages are immutable; matching content/UUID retries do not duplicate writes/alerts.

## Durable sync

`POST /sync` accepts at most 100 mutations:

```json
{
  "protocol": 2,
  "cursor": null,
  "mutations": [{
    "mutation_id": "11111111-1111-4111-8111-111111111111",
    "entity": "outings",
    "record": {
      "id": "22222222-2222-4222-8222-222222222222",
      "couple_id": "33333333-3333-4333-8333-333333333333",
      "title": "Cinema",
      "status": "planned",
      "is_deleted": false
    }
  }]
}
```

Response: `protocol:2`, opaque signed `cursor`, `acknowledgements` (mutation UUIDs), `has_more`, `remote_updates`. Remote updates include entity arrays plus `user`, `couple`, `partner`. Page using the returned cursor while `has_more` is true. Empty mutations request pull-only sync. Preference mutations use `users` record `{id,relationship_type}`; start-date mutations use `couples` record `{id,start_date}`.

Writes, receipts and cursor capture share a transaction. Identical mutation-ID/payload retries acknowledge without repeating writes; changed payload under the same mutation ID returns 409. Every edit gets a new mutation UUID, including edits of existing records. Message record UUIDs remain canonical.

Commit local writes and ordered outbox snapshots atomically. Apply remote rows, exact acknowledgements and cursor atomically. Older acknowledgements cannot clear later edits. HTTP failure never marks data synced. Scope cursors/outboxes to account/couple, guard in-flight responses against session changes, preserve history through logout/unpairing, and reconcile server membership before uploading cached-couple changes.

The journal stores changed IDs and returns current rows, not historical snapshots. Unavailable/deleted/private rows may be `{id,is_deleted:true}`. Hidden gift tombstones override partner cache visibility even when a conflicting local change is pending; preserve that change in quarantine. Cursors are signed/user-bound and reset their read position when the relationship changes.

## Legacy recovery

`POST /recovery`: `{records:[{entity,record}]}`, maximum 100. Response: `{retry:[{entity,id}],quarantine:[{entity,id}]}`. It does not upload records itself. SQLite integer booleans, stringified photo arrays and supported old date labels are normalized for validation. Malformed/private/cross-couple conflicts and old duplicated message IDs are quarantined individually. Genuine missing/newer rows can be queued through sync. Partner messages are never recreated under the current user's identity. Retain quarantined records rather than claiming upload success.

## Realtime and push

Socket.IO authentication: `auth:{token:JWT}`; avoid JWTs in URLs. `join_couple` refreshes membership-derived rooms and ignores supplied IDs. `receive_emote`: `{id,couple_id,sender_id,sender_name,emote,text,timestamp}`. `partner_joined`/`couple_ended` trigger sync/profile refresh. Socket message sending is disabled; persist over HTTP/sync. Sockets expire with JWTs.

FCM carries canonical message and sender/couple metadata. Deduplicate foreground FCM/socket notifications by UUID, ignore self messages and filter by active couple/session. Android displays background notification payloads; do not display a second local notification. Delivery is best effort after durable persistence; sync retrieves committed messages.

## Errors and health

Errors: `{error:"message"}`. Statuses: 400 invalid request/cursor, 401 invalid/expired login, 403 membership denied, 404 missing record/route, 409 identity/invitation/privacy conflict, 426 obsolete protocol, 429 throttled, 500 internal failure. Only 401 requires login; preserve pending writes for failures. Authentication/invitation/message throttling is 30/minute per route/IP in this single-instance release.

`GET /health` and `/ready` also exist at the host root. Readiness checks PostgreSQL and reports protocol 2. See [PRODUCTION.md](PRODUCTION.md) for coordinated rollout and operating limits.

Invitation codes use `AMOR-0000`. `renew:true` replaces an existing pending code and renews its seven-day expiry; without it a valid code is reused. `/couples/pair` accepts the full code or the four-digit suffix. Completed couples cannot be renewed into pending invitations.

Android pushes use data payloads with `recipient_id`, `couple_id`, canonical message `id`, sender metadata and display `title`/`body`. The native client receiver renders grouped notifications independently of Flutter startup. `push_delivery` server logs report `sent`/`reason` without tokens or message contents; `accepted` means FCM accepted the send, not that Android displayed it.
