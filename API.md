# API reference

Base URL `http://pgboss-scheduler:8020`. Everything under `/v1` needs
`Authorization: Bearer <token>`; tokens are `name:token` pairs in
`SCHEDULER_TOKENS`, and **the name is recorded on every job**.

Errors carry `detail`, matching what agent-runner does and what `app-sdk`
already surfaces.

## Open routes

| | | |
|---|---|---|
| `GET` | `/` | service descriptor. Unauthenticated, so a deploy can be verified with an anonymous `curl` through your reverse proxy. |
| `GET` | `/healthz` | liveness. The container healthcheck and an uptime monitor. |
| `GET` | `/readyz` | pg-boss started **and** `SELECT 1`. 503 with a `detail` when not. |
| `GET` | `/metrics` | Prometheus. Unauthenticated; private network. |

## Queues

### `POST /v1/queues`

Upsert. Idempotent.

| Field | Default | |
|---|---|---|
| `name` | — | lowercase, digits, `.` `-` `_`, 3–128 chars. Dots are the namespace separator. `.dlq` is reserved. |
| `mode` | `push` | `push` or `pull` |
| `target` | — | required for `push`, refused for `pull`. A URL string, or an agent target. |
| `payload` | `envelope` | `envelope` or `data` — see [Delivery](#push-delivery) |
| `policy` | `standard` | pg-boss queue policy. **Cannot be changed in place** → 409. |
| `retryLimit` | `3` | retries after the first attempt |
| `retryDelay` | `60` | seconds before the first retry |
| `retryBackoff` | `true` | then doubling |
| `retryDelayMax` | — | cap on the backoff |
| `expireInSeconds` | `900` | how long a job may stay active |
| `retentionSeconds` | `1209600` | 14 days |
| `deadLetter` | `<name>.dlq` | `null` disables it |
| `concurrency` | `2` | push only: in-flight deliveries from this process |
| `description` | `""` | |

An agent target:

```json
{"kind": "agent", "agent_id": "agents/qa-draft", "project": "agent-runner",
 "capture": "full", "max_cost_usd": 0.5}
```

`target.headers` may not set `authorization`, `content-type`, or any
`x-app-*` header — refused with a 400 rather than dropped, because a caller
who sets `authorization` believes the delivery is authenticated by it.

**Defaults are opinionated about the dead-letter queue.** Without one, a job that
fails its last retry is marked failed and aged out by retention, and the only
evidence it existed is a gap in whatever it was supposed to do.

| | |
|---|---|
| `GET /v1/queues` | every queue this service knows about |
| `GET /v1/queues/{name}` | one, with its counts |
| `DELETE /v1/queues/{name}` | **deletes its jobs too** |
| `GET /v1/queues/{name}/stats` | counts by state, from pg-boss's monitoring pass — so a job enqueued a second ago may not be counted yet |
| `POST /v1/queues/{name}/redrive` | move dead-lettered jobs back → `{redriven}` |

## Jobs

### `POST /v1/jobs`

```json
{"queue": "web.rebuild-site", "data": {"site": "docs"},
 "context": {"trace_id": "...", "actor": "cms", "cause": "a post was published"},
 "options": {"singletonKey": "docs", "singletonSeconds": 60, "startAfter": 3600}}
```

`options`: `id`, `priority`, `startAfter` (seconds, an ISO timestamp, or a date),
`singletonKey`, `singletonSeconds`.

**201** `{id, queue, context}`.
**200** `{id: null, suppressed: true, detail}` when a singleton or throttle rule
swallowed it. That is the rule working, not a failure — a caller treating it as
one will retry something correct.

| | |
|---|---|
| `GET /v1/jobs/{queue}/{id}` | the queue is in the path because pg-boss partitions by it |
| `POST /v1/jobs/{queue}/{id}/cancel` | → `{updated}` |
| `POST /v1/jobs/{queue}/{id}/retry` | |
| `POST /v1/jobs/{queue}/{id}/resume` | |

## Pull mode

| | |
|---|---|
| `POST /v1/queues/{name}/fetch` | `{batch_size}` (max 100) → `{jobs}`. **409 on a push queue.** |
| `POST /v1/jobs/{queue}/{id}/complete` | `{output}` |
| `POST /v1/jobs/{queue}/{id}/fail` | `{output}` — the queue's retry policy applies |

## Schedules

### `POST /v1/schedules`

```json
{"queue": "ops.morning-ping", "cron": "0 8 * * *", "tz": "America/New_York",
 "key": "daily-0800", "data": {...}, "context": {...}}
```

`tz` defaults to **`America/New_York`**, not UTC. A UTC default would make "every
morning at 8" arrive at 3am for half the year, and nothing about the symptom
would point here. `key` defaults to `default`, and names the schedule so one
queue can hold several.

| | |
|---|---|
| `GET /v1/schedules?queue=` | |
| `DELETE /v1/schedules/{queue}/{key}` | 204 |

## Push delivery

`POST` to the queue's target.

| Header | |
|---|---|
| `X-App-Signature` | `sha256=<hmac-sha256 of the raw body, SCHEDULER_SIGNING_KEY>` |
| `X-App-Job-Id` | **stable across retries — the idempotency key** |
| `X-App-Queue` | |
| `X-App-Trace-Id` | |
| `X-App-Delivery` | attempt number, 1-based |

Body, with `payload: "envelope"` (the default):

```json
{"queue": "web.rebuild-site", "job_id": "018f-abc", "delivery": 1,
 "data": {"site": "docs"}, "context": {...},
 "enqueued_by": "wordpress", "enqueued_at": "2026-08-30T12:00:00.000Z"}
```

With `payload: "data"`, the job's `data` verbatim and nothing else — for a
receiver with its own body format that will never learn ours (ntfy, Slack-style
webhooks). The metadata still travels in the headers.

**2xx completes the job. Anything else, or a timeout, fails it** and the retry
policy applies. Redirects are never followed.

**Delivery is at-least-once.** A receiver that does the work and then times out
will be called again — from here those cases are identical. Deduplicate on
`X-App-Job-Id`.

For an agent target the scheduler calls agent-runner's `POST /api/runs` and
treats any run status other than `ok` as a failed job.
