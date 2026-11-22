# PosiNext Cloud Scalability Readiness Audit

**Branch:** scalability-readiness-audit  
**Purpose:** Prepare the Hub for safe horizontal scaling without changing the offline POS or prematurely replacing SQLite.  
**Scope:** Repository architecture review based on source and deployment files. This is an audit/planning artifact; no runtime code or production deployment is changed.

## Executive summary

PosiNext Cloud is currently designed as a single Node.js Hub process using `node:sqlite`, local file storage, and persistent POS connections. It is not safe to launch multiple independent Hub copies behind a load balancer yet: they would have separate local databases/files and process-local connection/event state.

**Recommended approach:** preserve outlet POS SQLite and offline behavior. First make the Hub resilient and observable on one EC2; then externalize file storage and shared event/connection coordination; only then evaluate multi-instance deployment. Do not place the active SQLite database file on EFS/network storage and have multiple Node processes open it as a shared DB.

## Observed architecture

- Runtime: Node 24, native `node:sqlite`, zero runtime dependencies.
- Hub DB: one local database file, configured through `HUB_DATA_DIR`; DB module uses SQLite and WAL (source comments describe synchronous FULL and short transactions).
- Cloud service: paired outlet POS devices, orders, menu/configuration, licence/sales sync, guest relay, hosted outlets, backups, admin/customer APIs.
- Deployment: one systemd service on Ubuntu, Caddy reverse proxy, default Hub port 4900 (or 4910 alongside another Hub).
- Files: POS backup uploads and menu images are stored in Hub-managed local folders.
- POS-to-Hub live connection/event delivery and outlet tunnel behavior depend on long-lived connections.
- Backup script runs periodically and may copy off-server to S3 if configured.

## Component-level risk and readiness

| Component / file | Responsibility (observed or inferred from module) | Multi-instance readiness | Recommended action |
|---|---|---|---|
| `src/db.ts` | SQLite schema, connection/helpers | **Not ready** for multiple independent DB files | Keep single DB owner; inventory DB callers and isolate repository boundary |
| `src/hub.ts` | Core domain operations; imports DB, event emitter, backup/sync/analytics/inventory | **Needs review** | Map process-local state and domain service boundaries; avoid broad rewrite |
| `src/http.ts` | HTTP routes, SSE and WebSocket upgrades, relay and API orchestration | **Needs coordination** | Route classification; health endpoints; connection lifecycle inventory |
| `src/ws.ts` | WebSocket implementation | **Instance-local connections** | Shared event/connection routing or explicit sticky-routing design; reconnect handling |
| `src/relay.ts` | Guest relay; pending requests and cache held in Maps | **Instance-local state** | Shared relay request routing or ensure requests land on the POS-connected instance |
| `src/backups.ts` | Streams POS backups and menu images to local filesystem | **Local-filesystem dependency** | Storage adapter; S3-compatible object storage and safe retention |
| `src/hosted.ts` | Spawns per-outlet processes and stores outlet data under local directories | **Instance-affinity / local state** | Treat hosted-outlet workloads separately; do not scale this handler indiscriminately |
| `src/sync.ts` | Sales sync/licence renewals and stream acknowledgements | **Needs consistency review** | Idempotency, ownership and duplicate-job validation |
| `src/main.ts` | Boot/runtime wiring | **Single process entrypoint** | Graceful drain, health checks, lifecycle hooks |
| `deploy/install.sh` | Single-node installation/systemd/Caddy/backup setup | **Single-instance** | Keep as single-node installer; add separate ASG deployment assets only after prerequisites |

This matrix is a targeted review of identified modules, not a line-by-line verified audit of every route.

## Current bottlenecks / hazards

1. **Independent SQLite copies:** each EC2 instance with its own local disk has its own database; data is not shared.
2. **SQLite file-sharing caveat:** avoid treating EFS/network file sharing as a distributed database or opening a single SQLite file from multiple application instances.
3. **Local files:** backup uploads and menu images stored on disk are not automatically available to other EC2 instances.
4. **Persistent connection locality:** POS SSE/WebSocket/tunnel connections live on the process that accepted them; event producers on another instance need coordination.
5. **Process-local relay state:** pending guest requests and cache are held in Maps; instance changes can lose pending requests or strand them.
6. **Hosted outlet processes:** child processes and outlet directories are local to the Hub host; they require a separate placement/ownership strategy.
7. **Scale-in/shutdown:** a terminated instance must stop accepting new connections, drain active connections or force reconnect safely, and avoid interrupting jobs.
8. **Job duplication:** scheduled or background work must be idempotent or coordinated if run by multiple instances.

## Phased implementation

### Phase 0 — baseline (no production change)
- [ ] Document endpoint groups and classify each as stateless, DB-bound, file-bound, process-state-bound, or persistent-connection-bound.
- [ ] Measure CPU, memory, disk IO, SQLite lock/busy rates, request latency, connection counts, upload volume, and backup duration.
- [ ] Confirm SQLite WAL, backup/restore integrity and off-server backup success.
- [ ] Establish a reproducible test baseline.

### Phase 1 — resilience on one EC2
- [ ] Add explicit readiness/liveness health endpoint and startup/shutdown lifecycle.
- [ ] Graceful shutdown: stop accepting new requests, drain or close persistent connections with reconnect guidance, finish/abort jobs safely.
- [ ] Add structured logs and request correlation IDs.
- [ ] Add CloudWatch metrics/alerts and automated EC2 recovery.
- [ ] Harden and test backup restore (not just backup creation).
- [ ] Use idempotency/locking for recurring jobs.

### Phase 2 — decouple file storage
- [ ] Define a storage interface for backup/image operations.
- [ ] Keep local adapter for development/single-node.
- [ ] Add S3 adapter with streaming upload/download, metadata, integrity validation, and retention.
- [ ] Migrate files with verification and rollback plan.
- [ ] Remove shared-file assumptions from routes.

### Phase 3 — database boundary
- [ ] Inventory all direct `db.ts` calls in domain modules.
- [ ] Define domain repository interfaces; introduce gradually, not in one rewrite.
- [ ] Keep SQLite adapter as the initial implementation.
- [ ] Evaluate a **single SQLite-owning service** with RPC only if its bottleneck and failure model are acceptable; this still needs HA planning.
- [ ] Evaluate replicated SQLite products/protocols independently (consistency, write leadership, recovery, operational maturity); do not assume replication is equivalent to ordinary SQLite.
- [ ] If shared relational server DB becomes justified, implement adapter/migration only after contract and tests exist.

### Phase 4 — live connection/event coordination
- [ ] Inventory POS SSE, WebSocket, tunnel, hosted outlet proxy and guest relay flows.
- [ ] Define instance identity and connection registration.
- [ ] Define event fan-out/targeting, reconnect/resume and backpressure.
- [ ] Add cross-instance relay coordination.
- [ ] Test connection loss and instance termination.
- [ ] Select Redis/pub-sub or another mechanism only after requirements and traffic are measured.

### Phase 5 — multi-instance deployment
- [ ] Ensure API handlers are stateless or use shared state.
- [ ] Move Hub file assets to S3.
- [ ] Resolve DB ownership/sharing strategy.
- [ ] Resolve persistent-connection routing/event coordination.
- [ ] Define background-worker ownership and idempotency.
- [ ] Add ALB target health checks, connection draining, autoscaling policy and multi-AZ launch template.
- [ ] Test scale-out, scale-in, instance crash, reconnect, order consistency, backup and restore before production.

## Acceptance criteria for multi-instance readiness

- Two or more application instances see the same committed cloud data.
- A menu/store configuration update is visible regardless of the instance receiving the next request.
- Orders and idempotent requests cannot duplicate when retries or instance changes occur.
- POS streams reconnect safely after instance termination.
- Guest relay requests and replies are not lost due to instance locality.
- Shared images/backups are available across instances and integrity-checked.
- Hosted outlet processes are not accidentally launched twice or lost on scale-in.
- Scale-in drains safely and does not corrupt data or lose committed work.
- Backup restore is tested against a documented RPO/RTO.

## Suggested next code PRs (small, reviewable)

1. **PR 1:** Health/readiness endpoint, graceful shutdown, structured lifecycle logging, tests.
2. **PR 2:** storage interface + local adapter (no behavior change).
3. **PR 3:** S3 storage adapter + migration tooling/tests.
4. **PR 4:** repository boundary for one domain at a time.
5. **PR 5:** shared event coordination prototype + reconnect tests.
6. **PR 6:** ASG/ALB deployment template and staging test plan.

**Safety note:** this branch does not alter the main branch, runtime code, production deployment, or data. The next code implementation should be reviewed and tested locally/CI before merging or deploying.
