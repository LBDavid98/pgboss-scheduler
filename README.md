# pgboss-scheduler

**Scheduled and queued work behind an HTTP API.** [pg-boss][pgboss] on Postgres,
with push *or* pull delivery, signed deliveries, timezone-aware cron, and a
dead-letter queue per queue by default.

[pgboss]: https://github.com/timgit/pg-boss

```sh
cp .env.example .env     # DATABASE_URL, SCHEDULER_TOKENS, SCHEDULER_SIGNING_KEY
docker compose up -d
curl -s localhost:8020/healthz     # {"status":"ok"}
```

---

## Why this exists

Every app grows its own scheduler. It starts as an in-process `setInterval`, a
JSON file for a run log, and hand-written "did we miss 10:00 today?" catch-up
logic. It holds five real jobs, nothing else can use any of it, and **a job that
fails leaves no trace anyone can find.**

This is that, extracted once: durable in Postgres, callable over HTTP by
anything in any language, with the failure path built in rather than discovered.

If your app is a single process that owns its own database, you may not need
this — use pg-boss directly. This is for **several** services that need to
schedule work, including ones that are not Node.

---

## What it does

```console
$ curl -X POST localhost:8020/v1/queues -H "authorization: Bearer $TOKEN" \
    -d '{"name":"demo.ping","mode":"push","target":"https://example.com/hook"}'
{"queue":{"name":"demo.ping","mode":"push",
          "target":{"kind":"url","url":"https://example.com/hook"},
          "payload":"envelope","owner":"ops","concurrency":2,
          "retryLimit":3,"retryDelay":60,"retryBackoff":true,
          "deadLetter":"demo.ping.dlq",        ← created for you
          "counts":{"queued":0,"active":0,"failed":0,"total":0}}}
```

**The dead-letter queue is a default, not an option.** Without one, a job that
fails its last retry is marked failed and aged out by retention, and the only
evidence it ever existed is a gap in whatever it was supposed to do.

```console
$ curl -X POST localhost:8020/v1/jobs -H "authorization: Bearer $TOKEN" \
    -d '{"queue":"demo.ping","data":{"hello":"world"},"context":{"cause":"a README example"}}'
{"id":"2b346461-…","queue":"demo.ping",
 "context":{"trace_id":"08ee53b9-…","actor":"ops","cause":"a README example"}}
```

Every job carries an **actor** and a **trace id**. The actor is the *name* of
the token that enqueued it — which is why callers get a token each rather than
sharing one. Six months later "what put this here" has an answer.

```console
$ # same singleton key, twice
{"id":"e9567731-…","queue":"demo.ping","context":{…,"actor":"ops"}}
{"id":null,"suppressed":true,
 "detail":"not enqueued: a singleton or throttle rule on this queue suppressed it"}
```

**Suppression is a 200, not an error.** That is the rule working. A caller that
treats it as a failure will retry something that was correct.

```console
$ curl -X POST localhost:8020/v1/schedules -H "authorization: Bearer $TOKEN" \
    -d '{"queue":"demo.ping","key":"morning","cron":"0 8 * * *","tz":"America/New_York"}'
{"schedule":{"queue":"demo.ping","cron":"0 8 * * *","tz":"America/New_York","key":"morning"}}
```

Schedules are **timezone-aware and do not depend on the container's clock.**
pg-boss resolves `tz` through cron-parser and Intl, and Node 22 ships full ICU,
so `0 8 * * *` in `America/New_York` fires at 12:00Z — whatever `TZ` says. A
container claiming UTC while the operator thinks in local time is its own trap,
and this one does not fall into it.

---

## Push and pull

| Mode | How work leaves | For |
|---|---|---|
| **push** | the scheduler POSTs to your `target` when the job comes due | a receiver you can give a URL |
| **pull** | your worker calls `POST /v1/queues/{name}/fetch` | anything that cannot accept an inbound request |

### Signed deliveries

Every push carries an HMAC signature over the body, keyed by
`SCHEDULER_SIGNING_KEY`, so a receiver can prove the request came from your
scheduler and not from anything else that can reach its URL. Receivers that
verify it need no other authentication; receivers that do not are trusting the
network.

### Two payload shapes

`envelope` (the default) sends `{queue, job_id, data, context, …}` — the full
shape, for a receiver you control. `data` sends the job's `data` verbatim and
nothing else, for **foreign receivers** that have their own body format and
will not learn yours: ntfy's publish endpoint and Slack-style webhooks are the
motivating cases. Without it, every such receiver needs a translating shim
service in front of it. The delivery headers carry the job id, queue and trace
id either way.

`target.headers` may not set `authorization`, `content-type` or any reserved
header — refused with a 400 rather than silently dropped, because a caller who
sets `authorization` believes the delivery is authenticated by it.

### `agent` targets (optional)

A second target kind runs an agent on an HTTP agent runner exposing
`POST /api/runs`, because that API has a specific notion of failure: **HTTP 200
with `status: "error"` is a failed job**, and a plain `url` target would call
that a success and never retry. Encoding it here makes "run this agent every
morning" a queue definition rather than a webhook receiver somebody has to
write and maintain in every app.

Leave `AGENT_RUNNER_URL` unset and `url` targets work on their own.

---

## Configuration

Three values are **required**, and the process refuses to boot without them
rather than starting healthy and failing on the first job:

| | |
|---|---|
| `DATABASE_URL` | Postgres. The bundled compose brings its own. |
| `SCHEDULER_TOKENS` | `name:token` pairs, comma separated. The name becomes the job's `actor`. |
| `SCHEDULER_SIGNING_KEY` | ≥32 chars. Signs every push delivery. |

Generate the secrets with `openssl rand -hex 24` and `openssl rand -hex 32`.

Full endpoint reference: **[API.md](API.md)**.

---

## Operational notes

- `GET /` is an **unauthenticated** service descriptor, so a deploy can be
  verified with an anonymous `curl`. `GET /healthz` is liveness; `GET /readyz`
  is pg-boss started **and** `SELECT 1`, returning 503 with a `detail` when not.
- `GET /metrics` is Prometheus format, unauthenticated — keep it on a private
  network.
- The compose file binds the API to **loopback**. This service can enqueue work
  into anything it can reach and authenticates callers with bearer tokens only.
  Put it behind whatever already fronts your other services before changing
  that.
- `stop_grace_period` is 40s. Restarting drains in-flight deliveries and stops
  cron firing until it is back. **Nothing is lost** — the jobs are in
  Postgres — but a schedule that should have fired during the gap fires late,
  not never.
- `DELETE /v1/queues/{name}` **deletes its jobs too.**
- Queue stats come from pg-boss's monitoring pass, so a job enqueued a second
  ago may not be counted yet.

---

## Develop

```sh
npm install
npm run build
npm run test:unit          # 45 tests, no database needed
npm run test:integration   # needs a reachable Postgres
npm run typecheck
```

Dependencies are exactly pinned and the Postgres image is digest-pinned, so a
rebuild a year from now is the same stack this was verified against.

## License

MIT © David Hook
