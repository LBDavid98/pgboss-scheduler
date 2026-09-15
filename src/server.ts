/**
 * The HTTP surface.
 *
 * AUTH: everything under /v1 needs a bearer token; `/`, `/healthz`, `/readyz`
 * and `/metrics` do not. That split is deliberate:
 *
 *   /            answers the deploy script's verification curl, which arrives
 *                through the reverse proxy with no credential. It returns a name and a
 *                version and nothing that is not already public.
 *   /healthz     the container healthcheck and Uptime Kuma.
 *   /readyz      a real query, for anything that needs to know we can work.
 *   /metrics     Prometheus, which does not do bearer tokens by default and is
 *                on a private network.
 *
 * ERRORS carry `detail`, matching what the runner does and what a typed client's
 * client already knows how to surface. A caller sees the reason, not "400".
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import { callerFor } from "./auth.ts";
import { type Scheduler, QueueImmutableError } from "./boss.ts";
import { buildEnvelope, pack, unpack } from "./context.ts";
import * as metrics from "./metrics.ts";
import { QueueError, parseQueueSpec } from "./queues.ts";
import { TargetError } from "./targets.ts";
import { version } from "./version.ts";

/**
 * pg-boss types `CommandResponse` as an empty interface, but every command
 * actually returns `{ jobs, requested, affected }` (see manager.js). The count
 * is worth returning to a caller — "cancel: 0 affected" is the answer to "why
 * is it still running" — so the shape is asserted here, in one place, with the
 * reason attached rather than as a bare `as any` at four call sites.
 */
interface CommandCount {
  affected?: number;
}

/** A job row as this API reads it. pg-boss's own type is not index-signed. */
type JobRow = Record<string, unknown>;

declare module "fastify" {
  interface FastifyRequest {
    caller?: string;
  }
}

export function buildServer(config: Config, scheduler: Scheduler): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // The bearer token arrives in a header on every request. Fastify's default
      // serializer logs request headers, so this is not optional hygiene — it is
      // the difference between shipping tokens to Loki and not.
      redact: {
        paths: ["req.headers.authorization", "req.headers['x-app-signature']"],
        remove: true,
      },
    },
    // Job payloads are small by design. A 1MB body on a queue is a file that
    // should have been a reference to a file.
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof QueueError || error instanceof TargetError) {
      return reply.code(400).send({ detail: error.message });
    }
    if (error instanceof QueueImmutableError) {
      return reply.code(409).send({ detail: error.message });
    }
    if (error.validation) {
      return reply.code(400).send({ detail: error.message });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ detail: error.message });
    }
    app.log.error({ err: error.message }, "unhandled error");
    return reply.code(500).send({ detail: error.message });
  });

  // -- open routes -----------------------------------------------------------

  app.get("/", async () => ({
    service: "pgboss-scheduler",
    version,
    description: "Scheduled and queued work behind an HTTP API. pg-boss on Postgres.",
    docs: "https://github.com/LBDavid98/pgboss-scheduler#readme",
  }));

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await scheduler.ready();
      return { status: "ok" };
    } catch (error) {
      return reply.code(503).send({
        status: "not_ready",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return await metrics.registry.metrics();
  });

  // -- everything below needs a token ---------------------------------------

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/v1/")) return;
    const caller = callerFor(config, request.headers.authorization);
    if (!caller) {
      return reply.code(401).send({
        detail:
          "missing or unrecognised bearer token. Callers are named in SCHEDULER_TOKENS; " +
          "a token that works elsewhere on your fleet does not work here.",
      });
    }
    request.caller = caller;
  });

  // -- queues ----------------------------------------------------------------

  app.post("/v1/queues", async (request, reply) => {
    const spec = parseQueueSpec(
      (request.body ?? {}) as Record<string, unknown>,
      request.caller as string,
    );
    await scheduler.upsertQueue(spec);
    const queue = await scheduler.boss.getQueue(spec.name);
    return reply.code(201).send({ queue: describe(scheduler, spec.name, queue) });
  });

  app.get("/v1/queues", async () => {
    const queues = await Promise.all(
      scheduler.allSpecs().map(async (spec) => describe(scheduler, spec.name, await scheduler.boss.getQueue(spec.name))),
    );
    return { queues };
  });

  app.get("/v1/queues/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const queue = await scheduler.boss.getQueue(name);
    if (!queue) return reply.code(404).send({ detail: `no queue named ${name}` });
    return { queue: describe(scheduler, name, queue) };
  });

  app.delete("/v1/queues/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!(await scheduler.boss.getQueue(name))) {
      return reply.code(404).send({ detail: `no queue named ${name}` });
    }
    await scheduler.deleteQueue(name);
    return reply.code(204).send();
  });

  app.get("/v1/queues/:name/stats", async (request, reply) => {
    const { name } = request.params as { name: string };
    const queue = await scheduler.boss.getQueue(name);
    if (!queue) return reply.code(404).send({ detail: `no queue named ${name}` });
    return {
      name,
      deferred: queue.deferredCount,
      queued: queue.queuedCount,
      ready: queue.readyCount,
      active: queue.activeCount,
      failed: queue.failedCount,
      total: queue.totalCount,
    };
  });

  /** Move dead-lettered jobs back onto the queue they came from. */
  app.post("/v1/queues/:name/redrive", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!(await scheduler.boss.getQueue(name))) {
      return reply.code(404).send({ detail: `no queue named ${name}` });
    }
    return { redriven: await scheduler.boss.redrive(name) };
  });

  // -- jobs ------------------------------------------------------------------

  app.post("/v1/jobs", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const queue = String(body.queue ?? "");
    if (!queue) return reply.code(400).send({ detail: "jobs need a `queue`" });
    if (!(await scheduler.boss.getQueue(queue))) {
      return reply.code(404).send({ detail: `no queue named ${queue} — create it first` });
    }

    const envelope = buildEnvelope(body.context as never, request.caller as string);
    const options = sendOptions(body.options as Record<string, unknown> | undefined);
    const id = await scheduler.boss.send(
      queue,
      pack(body.data as Record<string, unknown>, envelope),
      options,
    );
    if (!id) {
      // pg-boss returns null when a singleton/throttle rule suppressed the send.
      // That is a normal outcome, not an error, and saying so is the difference
      // between a caller retrying forever and a caller understanding.
      return reply.code(200).send({
        id: null,
        suppressed: true,
        detail: "not enqueued: a singleton or throttle rule on this queue suppressed it",
        context: envelope.context,
      });
    }
    metrics.enqueued.inc({ queue, caller: request.caller as string });
    return reply.code(201).send({ id, queue, context: envelope.context });
  });

  app.get("/v1/jobs/:queue/:id", async (request, reply) => {
    const { queue, id } = request.params as { queue: string; id: string };
    // findJobs rather than getJobById: pg-boss 12 deprecates the latter.
    const [job] = await scheduler.boss.findJobs(queue, { id });
    if (!job) return reply.code(404).send({ detail: `no job ${id} on ${queue}` });
    return { job: describeJob(job as unknown as JobRow) };
  });

  for (const action of ["cancel", "retry", "resume"] as const) {
    app.post(`/v1/jobs/:queue/:id/${action}`, async (request) => {
      const { queue, id } = request.params as { queue: string; id: string };
      const result = (await scheduler.boss[action](queue, id)) as CommandCount;
      return { queue, id, action, updated: result?.affected ?? 0 };
    });
  }

  // -- pull mode -------------------------------------------------------------

  app.post("/v1/queues/:name/fetch", async (request, reply) => {
    const { name } = request.params as { name: string };
    const spec = scheduler.spec(name);
    if (spec && spec.mode === "push") {
      // A push queue's jobs are already being delivered by our own worker.
      // Letting a caller fetch from it as well would race the worker for the
      // same jobs and deliver some of them twice for no reason.
      return reply.code(409).send({
        detail:
          `${name} is a push queue — the scheduler delivers it to ${
            spec.target && spec.target.kind === "url" ? spec.target.url : "its target"
          }. Fetching would race that worker. Recreate it with mode "pull" to consume it yourself.`,
      });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const jobs = await scheduler.boss.fetch(name, {
      batchSize: Math.min(Number(body.batch_size ?? 1), 100),
      includeMetadata: true,
    });
    return { jobs: (jobs as unknown as JobRow[]).map(describeJob) };
  });

  app.post("/v1/jobs/:queue/:id/complete", async (request) => {
    const { queue, id } = request.params as { queue: string; id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = (await scheduler.boss.complete(queue, id, (body.output ?? {}) as object)) as CommandCount;
    return { queue, id, completed: result?.affected ?? 0 };
  });

  app.post("/v1/jobs/:queue/:id/fail", async (request) => {
    const { queue, id } = request.params as { queue: string; id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = (await scheduler.boss.fail(queue, id, (body.output ?? {}) as object)) as CommandCount;
    return { queue, id, failed: result?.affected ?? 0 };
  });

  // -- schedules -------------------------------------------------------------

  app.post("/v1/schedules", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const queue = String(body.queue ?? "");
    const cron = String(body.cron ?? "");
    if (!queue || !cron) {
      return reply.code(400).send({ detail: "schedules need a `queue` and a `cron`" });
    }
    if (!(await scheduler.boss.getQueue(queue))) {
      return reply.code(404).send({ detail: `no queue named ${queue} — create it first` });
    }

    const envelope = buildEnvelope(body.context as never, request.caller as string);

    // A SCHEDULE MUST NOT CARRY A TRACE ID, unless the caller insisted.
    //
    // The envelope is built ONCE here and then stored in the schedule's data,
    // so pg-boss stamps every future run with whatever is in it. A minted trace
    // id would therefore be identical for Tuesday's run and Wednesday's and
    // every run after — which is precisely the opposite of what a trace id is
    // for, and it makes "find this run in Grafana" return every run there has
    // ever been. Observed on 2026-08-30: three separate deliveries of
    // cc.agent-catchup all reported the same trace.
    //
    // Dropping it here means each run falls back to its own job id at delivery
    // time, so every occurrence is individually traceable. A caller who really
    // does want one id across a whole schedule can still pass `trace_id`
    // explicitly, and it is honoured.
    const callerGaveTrace = Boolean((body.context as { trace_id?: string } | undefined)?.trace_id);
    const scheduleEnvelope = callerGaveTrace
      ? envelope
      : { ...envelope, context: { ...envelope.context, trace_id: "" } };

    // A timezone is REQUIRED in effect: defaulting to UTC silently would make
    // "every morning at 8" arrive at 3am half the year. America/New_York is this
    // box's operating timezone (code-server, and a peer app's own
    // scheduler, both use it).
    const tz = String(body.tz || "America/New_York");
    const key = String(body.key || "default");

    await scheduler.boss.schedule(queue, cron, pack(body.data as Record<string, unknown>, scheduleEnvelope), {
      tz,
      key,
      ...sendOptions(body.options as Record<string, unknown> | undefined),
    });
    return reply.code(201).send({
      schedule: { queue, cron, tz, key },
      context: scheduleEnvelope.context,
    });
  });

  app.get("/v1/schedules", async (request) => {
    const { queue } = request.query as { queue?: string };
    const schedules = await scheduler.boss.getSchedules(queue);
    return {
      schedules: schedules.map((s) => ({
        queue: s.name,
        key: s.key,
        cron: s.cron,
        tz: s.timezone,
        data: unpack(s.data as Record<string, unknown>).data,
        context: unpack(s.data as Record<string, unknown>).envelope?.context ?? null,
      })),
    };
  });

  app.delete("/v1/schedules/:queue/:key", async (request, reply) => {
    const { queue, key } = request.params as { queue: string; key: string };
    await scheduler.boss.unschedule(queue, key);
    return reply.code(204).send();
  });

  return app;
}

/** pg-boss's job options, filtered to the ones this API exposes. */
function sendOptions(raw: Record<string, unknown> | undefined) {
  if (!raw) return {};
  return {
    ...(raw.id != null ? { id: String(raw.id) } : {}),
    ...(raw.priority != null ? { priority: Number(raw.priority) } : {}),
    ...(raw.startAfter != null ? { startAfter: raw.startAfter as string } : {}),
    ...(raw.singletonKey != null ? { singletonKey: String(raw.singletonKey) } : {}),
    ...(raw.singletonSeconds != null ? { singletonSeconds: Number(raw.singletonSeconds) } : {}),
    // THE DIFFERENCE BETWEEN COLLAPSING AND LOSING. `singletonSeconds` alone
    // THROTTLES: a second job inside the window is DROPPED and never runs.
    // That is right for "ping me at most once an hour" and badly wrong for
    // "rebuild the site after a publish" — an editor who fixes a typo 30
    // seconds after publishing gets their fix silently discarded, and the live
    // site is stale with nothing anywhere saying so.
    //
    // `singletonNextSlot` defers that job into the next slot instead, so the
    // burst still collapses to one run but the LAST state is the one built.
    // Found by testing exactly that case on 2026-08-30: six rapid edits
    // produced zero rebuilds.
    ...(raw.singletonNextSlot != null ? { singletonNextSlot: Boolean(raw.singletonNextSlot) } : {}),
  };
}

function describe(scheduler: Scheduler, name: string, queue: Awaited<ReturnType<Scheduler["boss"]["getQueue"]>>) {
  const spec = scheduler.spec(name);
  return {
    name,
    mode: spec?.mode ?? "pull",
    target: spec?.target ?? null,
    payload: spec?.payload ?? "envelope",
    description: spec?.description ?? "",
    owner: spec?.owner ?? "",
    concurrency: spec?.concurrency ?? null,
    policy: queue?.policy ?? null,
    retryLimit: queue?.retryLimit ?? null,
    retryDelay: queue?.retryDelay ?? null,
    retryBackoff: queue?.retryBackoff ?? null,
    expireInSeconds: queue?.expireInSeconds ?? null,
    retentionSeconds: queue?.retentionSeconds ?? null,
    deadLetter: queue?.deadLetter ?? null,
    counts: queue
      ? {
          deferred: queue.deferredCount,
          queued: queue.queuedCount,
          ready: queue.readyCount,
          active: queue.activeCount,
          failed: queue.failedCount,
          total: queue.totalCount,
        }
      : null,
  };
}

/** A job as a caller reads it: their data and our envelope, separated again. */
function describeJob(job: JobRow) {
  const { data, envelope } = unpack(job.data as Record<string, unknown>);
  return {
    id: job.id,
    queue: job.name,
    state: job.state ?? null,
    data,
    context: envelope?.context ?? null,
    enqueued_by: envelope?.enqueued_by ?? null,
    retry_count: job.retryCount ?? 0,
    retry_limit: job.retryLimit ?? null,
    start_after: job.startAfter ?? null,
    created_on: job.createdOn ?? null,
    completed_on: job.completedOn ?? null,
    output: job.output ?? null,
  };
}
