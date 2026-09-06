# Deployment and recovery

## Production storage

Run one replica of ZA-Game with Node.js 24. The Dockerfile selects the supported runtime. Attach a Railway volume to `/data`; set `STATE_FILE=/data/rooms.json`. No database service is necessary at this scale. Never use the ephemeral container filesystem as production storage. Healthcheck: `/health`.

Railway documentation checked September 5, 2026 lists volume storage at **$0.15 per GB per month of usage**, in addition to compute/network and the account's plan. Actual snapshot data is small; the fixed platform capacity is not a prepaid amount. No plan upgrade is authorized or needed by this code.

Sources: https://docs.railway.com/pricing/plans and https://docs.railway.com/volumes .

The running production service currently has a single replica. A volume named za-game-volume is attached at /data and STATE_FILE is set to /data/rooms.json. The Hobby plan supplies 5 GB maximum capacity and bills only stored data, not the unused capacity. The plan was not changed. Application snapshots are limited to 32 MiB each; current, previous and temporary copies together stay below 128 MiB of file data, well below the agreed $0.15/month storage budget at the documented usage rate. This is an application data limit, not a Railway account-wide billing cap. The new server refuses Railway startup unless STATE_FILE resolves inside RAILWAY_VOLUME_MOUNT_PATH. Do not merge into the production-linked branch before volume and variables are ready.

## State guarantees and limits

Each accepted action is synchronously serialized into a versioned, SHA-256 checked snapshot, fsynced, atomically renamed, and its directory fsynced before application success events are published. No raw reconnect tokens are persisted; only SHA-256 digests. Files are created owner-readable/writable. Corruption and unknown versions stop startup rather than silently discard games. A write failure stops gameplay and returns an unhealthy status; restore disk access and restart to resume the last durable snapshot. A filesystem crash immediately after rename can leave an action committed whose acknowledgement was lost; returning clients must read authoritative state rather than resend.

All active players must return after a restart before gameplay resumes. Disconnecting does not forfeit an active hand. Finished players do not pause a remaining game. Countdown restarts at 30 seconds after resumption. Inactive rooms expire after two hours, finished rooms after 30 minutes (cleanup runs every minute). Session lifetime is the room lifetime; explicit lobby/result departure revokes the seat. Separate tabs normally have separate sessionStorage sessions; the latest connection presenting a valid private session takes over and disconnects the previous transport. This also allows Wi-Fi/mobile-network handover before the old connection times out. Closing a tab may lose its sessionStorage, so cross-device recovery is not supported. No account system was added.

Snapshots include private hands: restrict backup access just as for the live volume. This implementation is a single-process design (max 200 rooms, eight players, 32 observers and eight queued players per room), not a multi-replica database. Multiple replicas or overlapping writers require a separate transactional database migration.

## Before production switch

1. Review the PR, CI and QA report. Real iOS/Android acceptance remains outstanding.
2. Provision the volume and variable after cost approval. Keep the service at one replica.
3. Verify there are no active old-version games before replacement. The legacy deployment stores its games in process memory and has no export API; restarting it loses those games. Old public-ID-only sessions cannot be securely migrated. Participants must start a new room after the upgrade.
4. Record the old deployment and commit. Configure volume backup in Railway and take a backup before future upgrades. This first upgrade has no prior durable snapshot.
5. Deploy the reviewed commit; verify healthy status and matching HTML. Play a full isolated acceptance game and reconnect. Do not crash or run malicious-payload tests against production.

## Backup and rollback

The live dashboard restricts Railway managed backups to Pro. No upgrade was performed. Instead the server keeps one fsynced previous snapshot at /data/rooms.json.previous, with owner-only permissions, replacing it on every commit. This protects against corruption of the current file; it does not protect against deletion or loss of the volume. Off-volume automated backup remains unconfigured. A private off-volume copy or Pro managed backups is a separate operational follow-up. The CLI file download route requires a registered Railway SSH key, which was not added.

For application rollback, select a prior *storage-compatible* deployment and preserve the mounted volume. For corrupt state, stop the service, preserve the corrupt file for diagnosis, restore a validated version-2 backup (including rooms.json.previous if valid), and restart. Restoring an older backup loses actions newer than that backup; communicate that before recovery. The original commit does not understand snapshots and must not be represented as preserving active new-version games.

Original production baseline: `c90e44b11c83c7163d658c462d2c3a4fbf7699d9`.

## Deployment record

The first stabilization release was deployed as merge commit 19ba8aadee582ff7f3e9d9c0ab30d5fdf082ae09. Docker build and /health passed. Production HTML matched reviewed source. A 69-turn production browser game passed, including in-game refresh/rejoin, results refresh, rematch and normal room departure. No crash tests were run on production. The follow-up PR adds bounded previous snapshots and hides fully disconnected saved rooms from the public room list without deleting them.
