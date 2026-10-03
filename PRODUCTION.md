# Production deployment

This release updates the backend and Android client to sync protocol 2. See [TODO.md](TODO.md) for verified work and remaining operator steps. Do not run Docker locally for this workflow.

## Build and checks

Use Node 22 and the committed lockfile:

```powershell
npm ci
npm run check
npm test
npm run build
npm audit --omit=dev
```

Tests start a temporary native PostgreSQL instance bound to localhost; they use neither Docker nor the production database. Native binaries download during dependency installation. `npm start` runs `dist/index.js`; the build copies SQL assets into `dist`. Backend CI runs on Windows.

## Portainer Git stack

Keep the existing repository `https://github.com/Thomas-Jefersson-Vaz/Chamego`, selected branch and `docker-compose.yml`. The server builds the Dockerfile, exposes `34343:34343` and connects to external PostgreSQL. It does not create a database container.

Set variables in Portainer's stack environment. The Git checkout does not contain an operator's `stack.env`.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@192.168.3.14:5432/chamego_db`, with real credentials and URL-encoded special characters |
| `JWT_SECRET` | Random secret of at least 32 characters; preserve across routine restarts |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Raw/base64 Firebase Admin JSON for the Android application's Firebase project |
| `REQUIRE_FCM` | `true` makes missing/invalid Firebase initialization fail startup; default `false` permits operation without push |
| `CORS_ORIGINS` | Comma-separated permitted browser origins; empty suffices for native Android |
| `TRUST_PROXY` | Actual trusted proxy IPs/CIDRs; empty for direct access |

Generate the JWT secret outside Git:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The container sets `NODE_ENV=production` and `PORT=34343`, runs as a non-root user, bounds logs and checks readiness. Database credentials, JWT secrets and Admin private keys belong outside source control. `.env` and service-account files are excluded from the image.

Terminate HTTPS at the reverse proxy. Forward `/api/*` and Socket.IO `/ws` to port 34343, including WebSocket Upgrade headers. The client base URL includes `/api`; sockets use `/ws` on the same host. Allow up to 1 MB JSON bodies and persistent socket connections. Trust only the proxy addresses actually in use so IP throttling is meaningful.

## Backup and migrations

Before the first restart, use the operator's normal authenticated PostgreSQL tools to back up the database. Configure `PGPASSFILE` outside Git rather than exposing a password in command history. Example:

```text
pg_dump -h 192.168.3.14 -p 5432 -U USER -d chamego_db -Fc -f chamego-before-protocol2.dump
pg_restore --list chamego-before-protocol2.dump
```

Verify restoration into a separate test database. Do not restore over the live database to test the backup.

Startup applies migrations transactionally under an advisory lock and records versions in `schema_migrations`. The database role must be able to create the UUID extension when absent, alter tables and create indexes/functions/triggers. A failed startup migration prevents listening. Existing records are retained. Migration 002 adds relationship/invitation fields, the journal, receipts and triggers. Ambiguous duplicate FCM tokens are cleared for re-registration; old pending invitations receive seven-day expiration.

Do not disable journal triggers or prune journal/receipt rows routinely: cursor and retry guarantees depend on them. App transactions use a shared advisory lock. This version targets the existing single API instance; its in-memory rate limiter is not shared across instances.

## Coordinated rollout

1. Prepare the matching signed Android release and preserve the previous code/client versions plus a verified database backup.
2. Commit intended changes and rebuild/redeploy the existing Git stack in Portainer on the server.
3. Verify `/health` and `/ready` return 200. Readiness checks PostgreSQL and reports `protocol: 2`.
4. Distribute the matching client. Old timestamp-sync clients receive HTTP 426; mixed sync versions are incompatible.
5. With two accounts/devices, verify login, invitations, pairing, offline edits/reconnect, retries without duplicate messages, secret gifts, unpairing and notification delivery.
6. Restart app/server and confirm pending local writes and committed server records survive.

JWTs expire after seven days; login is required again without deleting local pending writes. Rotating `JWT_SECRET` invalidates JWTs and signed cursors; coordinate new login/cursor reset when rotating, rather than changing it casually on restart.

Unpairing revokes current membership while retaining history. Old-couple pending writes stay on-device and are not reassigned to a new relationship. Conflicting legacy rows are retained in local quarantine and excluded from normal lists/uploads.

## Rollback and monitoring

Stop new traffic before rollback and preserve a fresh backup. Account for protocol compatibility: an old server cannot process the new client's sync contract. Migration 002 is additive, but code rollback alone does not recreate old sync guarantees. Restoring the pre-release backup discards later writes; reconcile them first. No automatic down-migration is provided.

Monitor readiness, 5xx responses, sync conflicts and restarts. `/health` is liveness; `/ready` checks PostgreSQL. Push/socket delivery is best effort after durable message persistence; clients can retrieve committed messages through sync after notification failure. Only one FCM token per user is retained. A durable push retry queue and multi-device push fan-out are outside this release.

See [the API guide](Chamego_API_Client_Guide.md) and the client project's `PRODUCTION.md` for signing/device acceptance.

## Chat notifications and short invitations update

Deploy the updated Flutter APK on both phones together with this backend. Android push delivery now sends high-priority data messages; the updated app renders grouped notifications with a monochrome icon in foreground and background. Older APKs will not display these data messages in the background. Live Firebase/device checks remain required.

New invitation codes use `AMOR-0000`, are allocated under the shared transaction lock, and remain stable until expired. Existing long invitations stay valid until refreshed by their owner. The four-digit namespace has 10,000 codes; allocation returns 503 if all codes are occupied, without changing existing relationships.
