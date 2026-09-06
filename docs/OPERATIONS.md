# Deployment and recovery

## Required storage (not yet provisioned)

Run one replica of ZA-Game with Node.js 24. The Dockerfile selects the supported runtime. Attach a Railway volume to `/data`; set `STATE_FILE=/data/rooms.json`. No database service is necessary at this scale. Never use the ephemeral container filesystem as production storage. Healthcheck: `/health`.

Railway documentation checked September 5, 2026 lists volume storage at **$0.15 per GB per month of usage**, in addition to compute/network and the account's plan. A 0.5 GB allocation is sufficient for this bounded small-game server; 0.5 GB actually used would cost about $0.075/month for storage, excluding backups. The exact current plan and available minimum allocation must be checked in the dashboard before creation. No plan upgrade is authorized or needed by this code.

Sources: https://docs.railway.com/pricing/plans and https://docs.railway.com/volumes .

The running production service currently has a single replica. The architecture view shows the application only; a persistent volume must be attached before deploying this branch. The new server refuses Railway startup unless STATE_FILE resolves inside RAILWAY_VOLUME_MOUNT_PATH. Do not merge into the production-linked branch before volume and variables are ready.

## State guarantees and limits

Each accepted action is synchronously serialized into a versioned, SHA-256 checked snapshot, fsynced, atomically renamed, and its directory fsynced before application success events are published. No raw reconnect tokens are persisted; only SHA-256 digests. Files are created owner-readable/writable. Corruption and unknown versions stop startup rather than silently discard games. A write failure stops gameplay and returns an unhealthy status; restore disk access and restart to resume the last durable snapshot. A filesystem crash immediately after rename can leave an action committed whose acknowledgement was lost; returning clients must read authoritative state rather than resend.

All active players must return after a restart before gameplay resumes. Disconnecting does not forfeit an active hand. Finished players do not pause a remaining game. Countdown restarts at 30 seconds after resumption. Inactive rooms expire after two hours, finished rooms after 30 minutes (cleanup runs every minute). Session lifetime is the room lifetime; explicit lobby/result departure revokes the seat. Separate tabs normally have separate sessionStorage sessions; a copied active session is rejected. Closing a tab may lose its sessionStorage, so cross-device recovery is not supported. No account system was added.

Snapshots include private hands: restrict backup access just as for the live volume. This implementation is a single-process design (max 200 rooms, eight players, 32 observers and eight queued players per room), not a multi-replica database. Multiple replicas or overlapping writers require a separate transactional database migration.

## Before production switch

1. Review the PR, CI and QA report. Real iOS/Android acceptance remains outstanding.
2. Provision the volume and variable after cost approval. Keep the service at one replica.
3. Verify there are no active old-version games before replacement. The legacy deployment stores its games in process memory and has no export API; restarting it loses those games. Old public-ID-only sessions cannot be securely migrated. Participants must start a new room after the upgrade.
4. Record the old deployment and commit. Configure volume backup in Railway and take a backup before future upgrades. This first upgrade has no prior durable snapshot.
5. Deploy the reviewed commit; verify healthy status and matching HTML. Play a full isolated acceptance game and reconnect. Do not crash or run malicious-payload tests against production.

## Backup and rollback

Enable Railway volume backups and choose retention appropriate to the account; backup pricing and schedule must be reviewed in the dashboard before enabling. A read-only file copy of the atomically replaced snapshot is also a consistent backup. Store it privately with restrictive permissions; never commit snapshots.

For application rollback, select a prior *storage-compatible* deployment and preserve the mounted volume. For corrupt state, stop the service, preserve the corrupt file for diagnosis, restore a validated version-2 backup, and restart. Restoring an older backup loses actions newer than that backup; communicate that before recovery. The original commit does not understand snapshots and must not be represented as preserving active new-version games.

Original production baseline: `c90e44b11c83c7163d658c462d2c3a4fbf7699d9`.
