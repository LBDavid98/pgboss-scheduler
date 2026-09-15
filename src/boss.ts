/**
 * pg-boss's lifecycle, and the workers that make push queues push.
 *
 * ONE pg-boss INSTANCE per process. It owns its own connection pool, its
 * maintenance loops and its cron worker; a second instance against the same
 * schema would duplicate all three.
 *
 * WORKER REGISTRATION IS DYNAMIC. A queue created through the API starts being
 * delivered immediately — `registerWorker` is called on the same request — and a
 * queue switched to pull or deleted has its worker stopped. Requiring a restart
 * to pick up a new queue would make every queue change an outage.
 */

import { PgBoss } from "pg-boss";
import pg from "pg";
import type { Config } from "./config.ts";
import { type DeliverableJob, DeliveryError, deliver } from "./delivery.ts";
import * as metrics from "./metrics.ts";
import {
  type QueueSpec,
  type StoredQueueConfig,
  bossQueueOptions,
  deleteQueueConfig,
  ensureSchema,
  isDeadLetterQueue,
  loadQueueConfigs,
  saveQueueConfig,
} from "./queues.ts";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export class Scheduler {
  readonly boss: PgBoss;
  readonly pool: pg.Pool;
  /** name -> spec, for every queue this process knows about. */
  private readonly specs = new Map<string, QueueSpec>();
  /** name -> pg-boss work id, for push queues only. */
  private readonly workers = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      schema: config.bossSchema,
      application_name: "pgboss-scheduler",
      // Cron lives here. This is the process that owns schedules; there is
      // exactly one of it, so there is no contention over the cron worker.
      schedule: true,
      supervise: true,
      migrate: true,
    });
    this.pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });

    // pg-boss reports maintenance problems through events rather than throwing
    // into a caller's request. Unhandled, an 'error' event on an EventEmitter
    // takes the process down.
    this.boss.on("error", (error: unknown) => this.log.error({ err: String(error) }, "pg-boss error"));
    this.boss.on("warning", (warning: unknown) => this.log.warn({ warning: String(warning) }, "pg-boss warning"));
  }

  async start(): Promise<void> {
    await this.boss.start();
    await ensureSchema(this.pool, this.config.schedulerSchema);
    const stored = await loadQueueConfigs(this.pool, this.config.schedulerSchema);
    for (const row of stored) {
      // The pg-boss side already exists — this only rebuilds the in-process
      // view and restarts the workers after a deploy.
      const spec = await this.rehydrate(row);
      this.specs.set(spec.name, spec);
      if (spec.mode === "push") await this.registerWorker(spec);
    }
    this.log.info({ queues: stored.length }, "scheduler started");
  }

  async stop(): Promise<void> {
    // Graceful: in-flight deliveries finish, nothing new is fetched. A killed
    // delivery is an at-least-once retry the receiver did not need.
    await this.boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {});
    await this.pool.end().catch(() => {});
  }

  spec(name: string): QueueSpec | undefined {
    return this.specs.get(name);
  }

  allSpecs(): QueueSpec[] {
    return [...this.specs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Create or update a queue on both sides — pg-boss's and ours — and bring its
   * worker into line with its mode.
   *
   * pg-boss's `updateQueue` refuses several fields that `createQueue` accepts
   * (policy, deadLetter, partition), so an existing queue whose policy changed
   * cannot simply be updated. That is surfaced rather than silently ignored.
   */
  async upsertQueue(spec: QueueSpec): Promise<void> {
    if (spec.deadLetter) {
      // The dead-letter queue must exist before a queue can name it as its
      // target, so it is created first, every time. Idempotent.
      await this.boss.createQueue(spec.deadLetter, {
        policy: "standard",
        retentionSeconds: spec.retentionSeconds,
      });
    }

    const existing = await this.boss.getQueue(spec.name);
    if (!existing) {
      await this.boss.createQueue(spec.name, bossQueueOptions(spec));
    } else {
      if (existing.policy && existing.policy !== spec.policy) {
        throw new QueueImmutableError(
          `queue ${spec.name} already exists with policy "${existing.policy}" and pg-boss ` +
            `cannot change a policy in place. Delete the queue and recreate it to move to ` +
            `"${spec.policy}" — note that deleting it discards its jobs.`,
        );
      }
      const { policy: _policy, deadLetter: _deadLetter, retryDelayMax: _max, ...updatable } =
        bossQueueOptions(spec);
      await this.boss.updateQueue(spec.name, updatable);
    }

    // PERSISTED, not just cached in this process. pg-boss stores the retry
    // policy but has no idea a queue is delivered by POST to a URL — that half
    // is ours, and without this row a queue survives a restart on pg-boss's
    // side while its worker never comes back and its jobs pile up undelivered.
    await saveQueueConfig(this.pool, this.config.schedulerSchema, spec);

    this.specs.set(spec.name, spec);
    await this.stopWorker(spec.name);
    if (spec.mode === "push") await this.registerWorker(spec);
  }

  async deleteQueue(name: string): Promise<void> {
    await this.stopWorker(name);
    this.specs.delete(name);
    await deleteQueueConfig(this.pool, this.config.schedulerSchema, name);
    await this.boss.deleteQueue(name);
  }

  /**
   * One pg-boss worker per push queue.
   *
   * `includeMetadata` is on because the delivery headers carry the attempt
   * number, and `retryCount` is only present on a job with metadata. Without it
   * every delivery would claim to be the first.
   */
  private async registerWorker(spec: QueueSpec): Promise<void> {
    const workId = await this.boss.work<Record<string, unknown>>(
      spec.name,
      {
        includeMetadata: true,
        batchSize: 1,
        localConcurrency: spec.concurrency,
        pollingIntervalSeconds: 2,
      },
      async (jobs: unknown[]) => {
        for (const job of jobs) {
          await this.runOne(job as unknown as DeliverableJob, spec);
        }
      },
    );
    this.workers.set(spec.name, workId);
    this.log.info({ queue: spec.name, concurrency: spec.concurrency }, "worker registered");
  }

  private async runOne(job: DeliverableJob, spec: QueueSpec): Promise<void> {
    const stop = metrics.deliveryDuration.startTimer({ queue: spec.name });
    try {
      const outcome = await deliver(job, spec, this.config);
      stop();
      metrics.deliveries.inc({ queue: spec.name, outcome: "ok" });
      this.log.info(
        {
          queue: spec.name,
          job_id: job.id,
          trace_id: outcome.trace_id,
          status: outcome.status,
          duration_ms: outcome.duration_ms,
          ...(outcome.run_id ? { run_id: outcome.run_id } : {}),
        },
        "delivered",
      );
    } catch (error) {
      stop();
      metrics.deliveries.inc({ queue: spec.name, outcome: "failed" });
      const attempt = (job.retryCount ?? 0) + 1;

      // A 4xx WILL NOT SUCCEED ON A RETRY, so do not spend retries on it.
      //
      // Retrying sends byte-identical bytes to the same URL: if the receiver
      // called the request malformed, unknown or unauthorised the first time,
      // it will call it that every time. Observed on 2026-08-30 — a schedule
      // registered without its data payload delivered {"job":""}, the receiver
      // correctly answered 400 unknown_job, and this burned four attempts over
      // several minutes before dead-lettering something that was never going to
      // work. The retries added delay and log noise and no information.
      //
      // 408 and 429 are the exceptions: those describe a transient condition at
      // the receiver, not a defect in the request, and are exactly what backoff
      // is for.
      const status = error instanceof DeliveryError ? error.status : null;
      const permanent = status !== null && status >= 400 && status < 500
        && status !== 408 && status !== 429;

      if (permanent) {
        this.log.warn(
          {
            queue: spec.name,
            job_id: job.id,
            trace_id: error instanceof DeliveryError ? error.trace_id : job.id,
            attempt,
            status,
            dead_letter: spec.deadLetter,
            err: error instanceof Error ? error.message : String(error),
          },
          "delivery rejected — not retrying a 4xx",
        );
        metrics.deadLettered.inc({ queue: spec.name });
        // Put it where a person will find it, then return normally so pg-boss
        // completes the job rather than scheduling another doomed attempt.
        if (spec.deadLetter) {
          await this.boss
            .send(spec.deadLetter, {
              ...(job.data ?? {}),
              __rejected__: {
                queue: spec.name,
                job_id: job.id,
                status,
                error: error instanceof Error ? error.message : String(error),
                at: new Date().toISOString(),
              },
            })
            .catch(() => {});
        }
        return;
      }

      const last = attempt > spec.retryLimit;
      if (last) metrics.deadLettered.inc({ queue: spec.name });
      // What failed, which attempt, and whether anything will try again. Never
      // the payload: a job's data is the caller's, and this ships logs to Loki.
      this.log.warn(
        {
          queue: spec.name,
          job_id: job.id,
          trace_id: error instanceof DeliveryError ? error.trace_id : job.id,
          attempt,
          of: spec.retryLimit + 1,
          status: error instanceof DeliveryError ? error.status : null,
          dead_letter: last ? spec.deadLetter : null,
          err: error instanceof Error ? error.message : String(error),
        },
        last ? "delivery failed — dead-lettering" : "delivery failed — will retry",
      );
      // Rethrow: this is how pg-boss is told to apply the retry policy.
      throw error;
    }
  }

  private async stopWorker(name: string): Promise<void> {
    if (!this.workers.has(name)) return;
    await this.boss.offWork(name).catch(() => {});
    this.workers.delete(name);
  }

  /**
   * Rebuild a full spec after a restart by joining our config row to pg-boss's
   * own record of the queue.
   *
   * BOTH HALVES ARE READ, deliberately. Defaulting the retry numbers here would
   * make a queue configured with retryLimit 5 report 3 in every log line after
   * the first restart — the queue would behave correctly, because pg-boss holds
   * the real value, and the logs about it would be wrong. A wrong log is worse
   * than a missing one.
   */
  private async rehydrate(row: StoredQueueConfig): Promise<QueueSpec> {
    const queue = await this.boss.getQueue(row.name);
    return {
      name: row.name,
      mode: row.mode,
      target: row.target,
      payload: row.payload,
      description: row.description,
      owner: row.owner,
      policy: queue?.policy ?? "standard",
      retryLimit: queue?.retryLimit ?? 3,
      retryDelay: queue?.retryDelay ?? 60,
      retryBackoff: queue?.retryBackoff ?? true,
      ...(queue?.retryDelayMax != null ? { retryDelayMax: queue.retryDelayMax } : {}),
      expireInSeconds: queue?.expireInSeconds ?? 900,
      retentionSeconds: queue?.retentionSeconds ?? 1_209_600,
      deadLetter: queue?.deadLetter ?? (isDeadLetterQueue(row.name) ? null : row.name + ".dlq"),
      concurrency: row.concurrency,
    };
  }

  /** Liveness of the thing underneath: a real query, not a cached flag. */
  async ready(): Promise<void> {
    await this.pool.query("SELECT 1");
    if (!(await this.boss.isInstalled())) {
      throw new Error("pg-boss schema is not installed");
    }
  }
}

export class QueueImmutableError extends Error {}
