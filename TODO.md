# Production readiness TODO

Updated: 2026-10-02. Covers the backend in `C:\Users\thoma\IdeaProjects\Chamego` and the Flutter client in `C:\Users\thoma\StudioProjects\chamego`.

Checked items are implemented. Implementation does not imply that deployment or device acceptance testing has passed. Code hardening and local verification are complete. Production rollout still requires the owner steps below; neither project has been deployed by this agent. Docker must not be run locally. The owner will commit the changes and restart the server when the remaining work is complete.

## Backend — implemented

- [x] Validate production JWT configuration; enforce authenticated account identity and active couple membership.
- [x] Validate request fields, UUIDs, entity types and payload sizes; return consistent API errors.
- [x] Harden authentication with password validation, bcrypt, bounded requests and rate limiting.
- [x] Enforce couple isolation and secret-gift privacy across CRUD and sync.
- [x] Use real, expiring invitation codes and transactional pairing; end relationships without deleting historical records.
- [x] Add non-destructive, versioned PostgreSQL migrations and transactional database helpers.
- [x] Implement protocol 2 sync with signed cursors, a change journal, durable mutation receipts, explicit acknowledgements and atomic writes.
- [x] Preserve canonical message UUIDs and derive message sender identity on the server.
- [x] Add legacy-record recovery with retry/quarantine decisions and detection of older duplicated message IDs.
- [x] Authorize Socket.IO rooms from database membership, use authentication tokens and expire socket sessions.
- [x] Make FCM token ownership unique and avoid clearing a newer token when an older token fails delivery.
- [x] Add liveness/readiness endpoints, redacted logging and graceful shutdown.
- [x] Prepare a compiled Node 22, non-root Docker image and Portainer environment configuration, preserving port 34343 and the external database arrangement.
- [x] Add build asset copying, backend CI and native temporary PostgreSQL integration tests without Docker.
- [x] Resolve the reported production dependency audit findings.

## Flutter client — implemented

- [x] Remove mock authentication, fake pairing, canned credentials and fabricated success responses.
- [x] Disable unsupported photo upload and password-reset flows.
- [x] Require a configured HTTPS API URL for release builds and bound HTTP request duration.
- [x] Store authentication tokens in secure storage, migrate legacy storage and stop persisting tokens in user rows.
- [x] Restore the correct cached account; isolate local data and pending writes by user and couple.
- [x] Add non-destructive SQLite migrations, a durable ordered outbox and legacy-data quarantine.
- [x] Save local changes and enqueue mutations atomically; acknowledge only the mutations the server explicitly accepted.
- [x] Keep newer local edits when acknowledging older writes; apply remote changes and cursor updates atomically.
- [x] Replace competing direct CRUD writes with the shared synchronization path.
- [x] Preserve offline changes and historical data through logout and unpairing.
- [x] Implement real invitations/pairing and truthful form/error states.
- [x] Refresh on app resume and partner events; reset provider state on session changes.
- [x] Authenticate realtime connections without JWTs in URLs and suppress duplicate/self message notifications.
- [x] Add notification permission handling, timezone-aware date calculations, reminder scheduling and cancellation on logout/unpairing.
- [x] Require external release signing configuration; disable cleartext traffic and Android backup in production.
- [x] Add a debug-manifest override for development cleartext traffic after finding a manifest merge failure.
- [x] Flag sync HTTP 401 responses as requiring login and repair the sync completion text.
- [x] Add 23 tests covering API failures, local migrations, outbox durability, acknowledgements, session isolation, privacy, tombstones, recovery, reminders and sync protocol.

## Verification already completed

- [x] Backend TypeScript check and compiled build passed, including the recovery endpoint changes.
- [x] All 17 backend integration tests passed, including existing-database migration, orphaned invitation rejection, token-specific revocation, recovery, socket revocation, privacy transitions, pagination and rollback.
- [x] Production npm dependency audit reported zero vulnerabilities at the last check.
- [x] Final Flutter analysis reported no issues.
- [x] All 23 Flutter tests passed, including changed membership, delayed provider loads, expired sessions and multiple recurring reminder occurrences.
- [x] Android debug APK build passed after the manifest fix and built-in Kotlin/timezone upgrade. Final source build passed. A transient Android Studio discovery error was resolved by rerunning with the installed JDK for that command; no global machine settings were changed.
- [x] Final backend TypeScript check, compiled build, 17 integration tests and production dependency audit passed.


## Implementation follow-ups — completed

- [x] Fix and test restored-session membership reconciliation before legacy recovery/outbox upload. The client now pulls current membership before sending any old-couple mutations; historical outbox entries are retained.
- [x] Review generation guards in asynchronous provider loads so an old session cannot repopulate visible state after logout or account switching.
- [x] Validate malformed legacy records during backend recovery and quarantine incompatible records without blocking all recoverable data.
- [x] Verify recurring reminders continue across multiple yearly/monthly occurrences when the app stays closed. Scheduling now covers up to 24 occurrences per date, with a total cap of 400 alarms, and refreshes during sync/resume. This is a rolling horizon, not unlimited scheduling.
- [x] Add regression coverage for the recovery endpoint and the latest socket join/unpair race fix; cover the membership reconciliation fix.
- [x] Review recovery/privacy transitions, sync pagination and rollback behavior for remaining edge cases.
- [x] Finish the final review of both projects and resolve any failures found.

## Checks, documentation and release steps

- [x] Rerun backend tests, TypeScript check and build after final fixes.
- [x] Rerun Flutter analysis, tests and Android debug build after final fixes.
- [ ] Owner: supply the actual HTTPS API URL and existing release signing material, then build/install the signed Android release. `android/key.properties` is currently absent; no release signing key was generated or replaced.
- [x] Document production setup in both projects: Portainer variables, migrations, backup/restore, health checks, signing and coordinated protocol 2 rollout.
- [x] Replace or correct obsolete setup/API instructions and document supported versus disabled features.
- [x] Add client CI checks if the client is going to be maintained in its own repository. The client directory was not a Git repository when inspected.
- [x] Review platform/plugin build warnings: upgraded timezone plugin to 5.1.0, aligned compiler to Kotlin 2.3.20, and enabled built-in Kotlin. The build passes; the remaining conditional-plugin/deprecation warnings are documented in the client production guide.
- [ ] Owner/device acceptance tests: registration/login, offline edits/reconnect, restart persistence, pairing/unpairing, private gifts, two-device messages, notification permissions/taps and reminders.

## Owner/server steps — after the code is finished

- [ ] Supply the production HTTPS API URL, external PostgreSQL credentials, strong JWT secret, Firebase configuration and Android signing material outside Git.
- [ ] Back up the existing PostgreSQL database before the migration/restart.
- [ ] Review and commit both projects' intended changes; preserve unrelated pre-existing IDE changes as appropriate.
- [ ] Restart/redeploy the Portainer Git stack on the server. No local Docker execution is required.
- [ ] Confirm startup migrations and `/health` plus `/ready`, then perform a two-account/two-device smoke test.
- [ ] Roll out the updated client together with the protocol 2 backend; older client sync is not compatible with the new protocol.
- [ ] Verify real FCM delivery, socket reconnection and reminders on the deployed environment.

## Known boundaries

- Server deployment, live database migrations and real-device/Firebase delivery have not been validated.
- Push delivery is best effort after a durable message write; a durable push-job/retry queue has not been implemented.
- Unsupported photo uploads/password reset remain disabled.
- No commit, server restart or production rollout has been performed.

## Additional fixes completed during final review

- [x] Pull visibility changes before uploading so private-gift conflicts cannot permanently block the outbox. Quarantine conflicting pending gift edits and retain their rows.
- [x] Validate new offline payloads before saving; retain malformed legacy dirty data in quarantine.
- [x] Guard session changes during SQLite transactions and provider completion so old writes cannot be assigned to a new account.
- [x] Refresh providers/realtime/timers on membership changes; require actual inviter membership for pairing.
- [x] Revoke only the attempted FCM token, preserving a newer device registration.
- [x] Normalize legacy special-date labels; schedule/display real future occurrences instead of sample dates or unsupported online-presence claims.
- [x] Include UTC timezone in creation/update instants and retain the original legacy message timestamp for conservative duplicate detection.
- [x] Await form saves, prevent double submissions, bound input and show truthful date/message-save failures.
- [x] Complete backend/client production guides, replace obsolete API/setup guides and add client CI.

## Verification summary

| Project | Checks | Result |
| --- | --- | --- |
| Backend | TypeScript, compiled build, native PostgreSQL integration tests | Passed; 17 tests |
| Backend | `npm audit --omit=dev` | 0 vulnerabilities |
| Client | `flutter analyze`, `flutter test` | No analysis issues; 23 tests passed |
| Client | `flutter build apk --debug --no-pub` | Passed |
| Release/server/device | Signed build, live migrations, HTTPS/FCM/device smoke tests | Pending owner configuration and rollout |

No local Docker execution, commit or server deployment was performed during this continuation. The unchecked items are release/operator checks, not claims of completed production validation.
