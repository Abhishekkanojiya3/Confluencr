# MARS Cosmetics — Order & Inventory Sync Service

## 1. Proposal

Use PostgreSQL as the inventory source of truth, Redis only for short-lived rate-limit/worker coordination, and durable PostgreSQL outbox tables for every external side effect. Channel adapters normalize webhooks/polls into one order model. A single database transaction deduplicates the event, reserves stock for every line, appends an inventory ledger entry, and creates outbox work for ERP and channel stock updates.

Delivery to external systems is **at least once**, with idempotency keys and reconciliation making the business result exactly once. This distinction matters: no service can guarantee exactly-once behavior across a database and an external HTTP API without cooperation from that API.

The service runs as containerized NestJS workers on ECS/Fargate (or equivalent AWS containers), with RDS PostgreSQL, ElastiCache Redis, and CloudWatch. API/webhook, ingestion workers, reservation workers, stock-push workers, ERP workers, and the ops API scale independently.

![Architecture](architecture.mmd)

## 1.1 CDC pipeline proposal

Use a **transactional outbox CDC pattern** rather than treating the inventory table itself as an event stream:

```text
PostgreSQL transaction
  ├─ update inventory + append inventory_ledger
  └─ insert order/ERP/stock outbox rows
          ↓
Outbox relay (small NestJS worker, SKIP LOCKED)
          ↓
SQS queues: erp-orders, stock-updates, audit-events
          ↓
independent consumers: ERP, channel adapters, audit/analytics
```

The business transaction and the event record commit together, so a committed reservation always has a durable downstream event. Consumers acknowledge only after successful handling, use the outbox ID as their deduplication key, and send poison messages to a dead-letter queue. The relay is horizontally scalable because rows are claimed with `FOR UPDATE SKIP LOCKED`; publishing is at-least-once and consumers are idempotent.

This is the recommended v1 CDC pipeline because it keeps the bill and operational surface small: PostgreSQL, the existing NestJS workers, and SQS are enough for the stated volume. It also avoids putting an external API call inside a database trigger. If later consumers need the full database change stream—not just business events—add a logical-replication reader (Debezium or AWS DMS) from the PostgreSQL WAL into a streaming backbone. That is useful for a warehouse/analytics lake, but it is not required for order correctness and would add cost and operations for a three-person team.

## 2. Data model

### `orders`

`id UUID PK`, `channel`, `external_order_id`, `status`, `event_version`, `event_time`, `received_at`, `total_amount`, `erp_status`, `created_at`, `updated_at`.

Constraint: `UNIQUE(channel, external_order_id)`. This is the primary order deduplication key. Status transitions are monotonic and recorded in `order_events`.

### `order_items`

`order_id FK`, `line_no`, `sku`, `qty`, `unit_price`, `reserved_qty`, `released_qty`.

Constraint: `PRIMARY KEY(order_id, line_no)`, `qty > 0`, `reserved_qty >= 0`, `released_qty >= 0`, and `reserved_qty + released_qty <= qty`.

### `inventory`

`sku PK`, `on_hand`, `reserved`, `version`, `updated_at`.

Constraint: `on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`. Available stock is `on_hand - reserved`; it is never independently edited.

### `inventory_ledger`

Append-only audit rows: `id`, `sku`, `delta_on_hand`, `delta_reserved`, `reason`, `order_id`, `channel`, `actor`, `correlation_id`, `created_at`.

Reasons include `ORDER_RESERVED`, `ORDER_CANCEL_RELEASED`, `RETURN_RELEASED`, `WAREHOUSE_RECEIPT`, and `MANUAL_ADJUSTMENT`. This answers why, when, and which order caused every change.

### `order_events`

`id`, `channel`, `external_order_id`, `event_type`, `source_event_id`, `event_time`, `payload_json`, `received_at`, `processed_at`.

Constraint: unique `(channel, source_event_id)` when the channel supplies an event ID. If it does not, use `(channel, external_order_id, event_type, payload_hash)`.

### Outbox tables

`erp_outbox(id, order_id UNIQUE, idempotency_key UNIQUE, status, attempts, next_attempt_at, last_error, sent_at)` ensures one durable ERP command per confirmed order.

`stock_outbox(id, sku, target_channel, target_available_qty, inventory_version, status, attempts, next_attempt_at, last_error)` stores the latest desired quantity. A partial unique index for pending work on `(sku, target_channel)` allows workers to coalesce several changes into one call.

`dead_letters` stores exhausted messages and their payload/error for ops retry. `sync_attempts` stores every external attempt and response class.

## 3. Ingestion and reservation

Each adapter does only transport work: authenticate/validate the request, persist the raw event, and acknowledge the webhook quickly. A poller stores a cursor/watermark for Flipkart and fetches pages every two minutes. Polling overlaps the previous window slightly, so a crash cannot create a gap; the unique event/order constraints remove duplicates.

The normalizer converts channel payloads to a canonical command:

```json
{
  "channel": "NYKAA",
  "external_order_id": "NYK-20261023-884213",
  "event_type": "ORDER_CREATED",
  "event_time": "2026-10-23T11:04:52+05:30",
  "items": [{"sku": "MRS-LIP-104", "qty": 2, "unit_price": 349.0}],
  "idempotency_key": "NYKAA/NYK-20261023-884213"
}
```

The reservation worker executes the following in one PostgreSQL transaction:

```text
BEGIN
  INSERT order ... ON CONFLICT(channel, external_order_id) DO NOTHING
  if already present: apply only a newer valid state transition; COMMIT

  for each SKU in sorted SKU order:
    SELECT inventory FOR UPDATE
    if on_hand - reserved < requested_qty: ROLLBACK; mark REJECTED_NO_STOCK
    UPDATE inventory SET reserved = reserved + qty, version = version + 1
    INSERT inventory_ledger(ORDER_RESERVED)
    INSERT/merge stock_outbox for each channel

  UPDATE order SET status = CONFIRMED
  INSERT order_event(PROCESSED)
  INSERT erp_outbox(order_id, idempotency_key)
COMMIT
```

Sorting SKUs before row locking gives a stable lock order and reduces deadlocks. A deadlock is retried with jitter. Cancellation and return use the same transaction, but decrement `reserved` only once using an order state transition; a return policy determines whether the unit is immediately sellable or awaits warehouse inspection.

Out-of-order events are handled by a per-order state machine and event timestamps/source versions. Terminal states are not moved backwards. Unknown cancellation-before-create events are retained pending until the create arrives or sent to ops review.

## 4. Last-unit concurrency example

Suppose available stock for SKU X is 1 and two channels sell it simultaneously. Transaction A locks the inventory row, observes 1, increments `reserved` to 1, writes its ledger/outbox rows, and commits. Transaction B waits for the lock, then observes available 0 and rolls back its reservation. The second order is marked `REJECTED_NO_STOCK` (or the channel-specific failure state), so the database cannot oversell even if both webhooks arrived in the same millisecond. The channel stock outbox then publishes zero to all channels.

## 5. Stock propagation

Every successful reservation/release increments `inventory.version` and upserts one desired stock message per `(sku, channel)`. Workers read the newest desired value, not every intermediate value, so a SKU changing five times produces one final call.

- Own website: update the owned database/API in the same deployment boundary; use the same outbox for auditability.
- Nykaa: token-bucket limiter at 5 requests/second, one SKU per request; prioritize zero-stock and oldest pending work.
- Flipkart: batch up to 50 SKUs and limit to 10 requests/second; retry 429 using `Retry-After` plus exponential backoff.
- Blinkit: daily CSV is the baseline; urgent changes use the REST worker with timeout, jittered retry, and reconciliation against the next CSV. Treat a timeout as unknown outcome and retry with the same idempotency key if supported.

The normal-load SLA is met by coalescing, priority queues, and independent workers. The Nykaa contract is a hard capacity ceiling of 300 SKU calls/minute. If more than 300 distinct Nykaa SKU changes must be published in one minute, the stated API cannot satisfy a 60-second SLA; v1 must alert and either obtain a bulk endpoint or negotiate that exception. This is an explicit feasibility boundary, not something the service can solve with more workers.

## 6. ERP delivery and failure handling

The ERP worker claims `erp_outbox` rows using `FOR UPDATE SKIP LOCKED`. It sends `idempotency_key = channel/external_order_id` and marks the row sent only after a successful response. Timeouts are retried because the result is unknown; a status lookup or idempotent resend resolves ambiguity. Business 4xx errors go to the ops queue after validation; transient 5xx/429 errors use exponential backoff with a cap.

During the Sunday 1–2 hour outage, confirmed orders continue reserving stock and accumulate in `erp_outbox`. Workers pause/back off based on health checks, then drain with a concurrency limit after recovery. A unique ERP key plus a daily reconciliation job prevents duplicate invoices and finds orders accepted by ERP but not acknowledged locally.

Messages that fail five times move to `dead_letters`, raise an alert, and appear on the ops screen with payload, last error, attempt history, and a safe Retry action. Retry is idempotent and does not create a second reservation.

## 7. Observability and operations

Day-one metrics/alerts:

1. `inventory_reservation_rejections_total` and reserved-versus-on-hand invariant violations (page immediately).
2. Age of oldest pending `stock_outbox` item by channel; alert at 45 seconds.
3. Age and count of pending `erp_outbox`; alert before the Sunday backlog becomes operationally risky.
4. Webhook/poll ingestion lag, duplicate rate, and adapter error rate.
5. External call latency, 429/5xx/timeout rate, and dead-letter count.

Structured logs carry `correlation_id`, channel, external order ID, SKU, inventory version, and outbox ID. Traces cover ingest → reservation → ERP/stock delivery. The ops UI reads failed syncs and supports retry, inspect, and acknowledge; it cannot directly edit inventory without a separate audited adjustment action.

## 8. Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Inventory source of truth | PostgreSQL row-level locking and ledger | Redis-only counters | Strong transactions, auditability, and recovery matter more than a few milliseconds. |
| Async delivery | PostgreSQL outbox + workers | Synchronous channel/ERP calls in webhook request | Webhooks stay fast and outages do not lose orders. |
| Event bus | Start with PostgreSQL outbox; add SQS only if measured backlog requires it | Kafka/MSK in v1 | 8k/day and 300/min peak do not justify Kafka cost/operations for a 3-person team. SQS is a later decoupling option. |
| Stock updates | Coalesced per-SKU/channel desired state | Replay every intermediate quantity | External APIs need the latest truth; coalescing reduces rate-limit pressure. |
| Exactly-once ERP | Idempotent API key + reconciliation | Claim a literal exactly-once HTTP guarantee | External side effects can time out after success; idempotency is the defensible guarantee. |

## 9. Scope and assumptions

- One warehouse and one inventory unit per SKU in v1; no bundles/kit explosion unless supplied as normalized SKU lines.
- Business Central accepts an idempotency/reference key or supports lookup by external order reference. If it does not, the integration must use a durable reconciliation key before production.
- Channel payloads contain stable order IDs, event IDs or enough fields to hash an event, and a cancellation/return signal.
- A confirmed order means payment/channel acceptance is sufficient to reserve stock; fraud review and fulfillment allocation are outside v1.
- Inventory adjustments are produced by a warehouse feed or audited ops action; the service does not attempt warehouse robotics integration.
- Authentication, secrets, TLS, and webhook signatures use standard AWS Secrets Manager/IAM and channel-provided credentials.
- Return stock becomes available only after the configured inspection state.
- Backup/restore, migrations, and a reconciliation job are included; advanced forecasting, partial shipments, split orders, multi-warehouse routing, and a customer-facing order portal are out of scope.

## 10. Six-week delivery shape

Weeks 1–2: schema, canonical model, website/Nykaa adapters, reservation transaction, tests for duplicate and concurrent orders.

Weeks 3–4: Flipkart poller, Blinkit CSV/API adapter, stock outbox/rate limiters, ERP outbox, reconciliation.

Weeks 5–6: ops UI, metrics/alerts, load/failure tests, channel contract tests, deployment runbook, and sale-day rehearsal.

**AI usage note:** ChatGPT was used to help structure and review this design; all assumptions, concurrency behavior, and trade-offs were validated against the assessment brief.
