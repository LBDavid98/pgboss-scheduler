/**
 * Queue definitions — the part pg-boss does not model.
 *
 * pg-boss knows a queue's retry policy, retention and dead-letter target. It has
 * no idea that a queue is delivered by HTTP POST to a particular URL, or that it
 * belongs to Foreman, or that its body should be shaped for ntfy. That is ours,
 * and it lives in our own table in our own schema so that a pg-boss migration
 * never has an opinion about it.
 *
 *   pgboss.*            pg-boss's tables. It owns them; we never write them by hand.
 *   scheduler.queue_config   ours: mode, target, payload shape, description, owner.
 *
 * The two are kept consistent by going through `upsertQueue` below, never by
 * writing either side directly.
 */

import type { Pool } from "pg";
import { type PayloadMode, type Target, parseTarget } from "./targets.ts";

export type QueueMode = "push" | "pull";

export interface QueueSpec {
  name: string;
  mode: QueueMode;
  target: Target | null;
  payload: PayloadMode;
  description: string;
  owner: string;
  policy: string;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  retryDelayMax?: number;
  expireInSeconds: number;
  retentionSeconds: number;
  deadLetter: string | null;
  /** Push only: how many deliveries may be in flight at once from this process. */
  concurrency: number;
}

export class QueueError extends Error {}

/**
 * Queue names become table partitions and URL path segments, so they are
 * restricted rather than validated loosely. Dots are allowed and encouraged as
 * the namespace separator — `cc.agent-maintenance`, `ops.morning-ping` — because
 * a flat namespace across five apps collides within a month.
 */
const NAME = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;

/** The suffix every auto-provisioned dead-letter queue gets. */
export const DLQ_SUFFIX = ".dlq";

export function isDeadLetterQueue(name: string): boolean {
  return name.endsWith(DLQ_SUFFIX);
}

/**
 * Validate and fill in a queue spec.
 *
 * DEFAULTS ARE OPINIONATED, and the important one is `deadLetter`. Unless the
 * caller says otherwise, every queue gets `<name>.dlq` and pg-boss moves an
 * exhausted job there. The alternative — pg-boss's own default of no dead letter
 * — means a job that fails its last retry is simply marked failed and aged out
 * by retention, and the only evidence it ever existed is a gap in whatever it
 * was supposed to do. A dead-letter queue costs one row and makes that
 * recoverable.
 */
export function parseQueueSpec(raw: Record<string, unknown>, owner: string): QueueSpec {
  const name = String(raw.name ?? "");
  if (!NAME.test(name)) {
    throw new QueueError(
      `queue name ${JSON.stringify(name)} is not usable: lowercase letters, digits, ` +
        "dot, dash and underscore only, 3-128 characters, starting and ending alphanumeric",
    );
  }
  if (isDeadLetterQueue(name)) {
    throw new QueueError(
      `${DLQ_SUFFIX} is reserved — dead-letter queues are created for you. ` +
        `Define ${name.slice(0, -DLQ_SUFFIX.length)} instead.`,
    );
  }

  const mode = (raw.mode ?? "push") as QueueMode;
  if (mode !== "push" && mode !== "pull") {
    throw new QueueError(`mode must be push or pull — got ${String(mode)}`);
  }

  if (mode === "push" && raw.target == null) {
    throw new QueueError("a push queue needs a target — that is what push means");
  }
  if (mode === "pull" && raw.target != null) {
    // Refused, not ignored: a pull queue delivers nothing, so a target on one is
    // a misunderstanding that would otherwise sit in the config looking correct.
    throw new QueueError(
      "a pull queue has no target: nothing is delivered, the consumer calls /fetch. " +
        'Use mode "push" to have the scheduler deliver.',
    );
  }

  const payload = (raw.payload ?? "envelope") as PayloadMode;
  if (payload !== "envelope" && payload !== "data") {
    throw new QueueError(`payload must be envelope or data — got ${String(payload)}`);
  }

  const deadLetter =
    raw.deadLetter === null || raw.deadLetter === false
      ? null
      : raw.deadLetter
        ? String(raw.deadLetter)
        : name + DLQ_SUFFIX;

  return {
    name,
    mode,
    target: raw.target == null ? null : parseTarget(raw.target),
    payload,
    description: String(raw.description ?? ""),
    owner,
    policy: String(raw.policy ?? "standard"),
    retryLimit: num(raw.retryLimit, 3, 0, 100, "retryLimit"),
    // 60s, doubling. A receiver that is down is usually down for more than the
    // 5 seconds it would take pg-boss's own default to burn every retry.
    retryDelay: num(raw.retryDelay, 60, 0, 86_400, "retryDelay"),
    retryBackoff: raw.retryBackoff == null ? true : Boolean(raw.retryBackoff),
    ...(raw.retryDelayMax != null
      ? { retryDelayMax: num(raw.retryDelayMax, 3600, 1, 86_400, "retryDelayMax") }
      : {}),
    expireInSeconds: num(raw.expireInSeconds, 900, 1, 86_400, "expireInSeconds"),
    // 14 days. Long enough that Monday's question about Friday's job can be
    // answered from the queue itself rather than from logs.
    retentionSeconds: num(raw.retentionSeconds, 1_209_600, 60, 31_536_000, "retentionSeconds"),
    deadLetter,
    concurrency: num(raw.concurrency, 2, 1, 50, "concurrency"),
  };
}

function num(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new QueueError(`${field} must be a number between ${min} and ${max} — got ${String(value)}`);
  }
  return Math.floor(parsed);
}

/** The options pg-boss itself understands, extracted from our fuller spec. */
export function bossQueueOptions(spec: QueueSpec) {
  return {
    policy: spec.policy as never,
    retryLimit: spec.retryLimit,
    retryDelay: spec.retryDelay,
    retryBackoff: spec.retryBackoff,
    ...(spec.retryDelayMax != null ? { retryDelayMax: spec.retryDelayMax } : {}),
    expireInSeconds: spec.expireInSeconds,
    retentionSeconds: spec.retentionSeconds,
    ...(spec.deadLetter ? { deadLetter: spec.deadLetter } : {}),
  };
}

// -- persistence -------------------------------------------------------------

export async function ensureSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${quote(schema)}.queue_config (
      name          text PRIMARY KEY,
      mode          text NOT NULL,
      target        jsonb,
      payload       text NOT NULL DEFAULT 'envelope',
      description   text NOT NULL DEFAULT '',
      owner         text NOT NULL DEFAULT '',
      concurrency   integer NOT NULL DEFAULT 2,
      created_on    timestamptz NOT NULL DEFAULT now(),
      updated_on    timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function saveQueueConfig(pool: Pool, schema: string, spec: QueueSpec): Promise<void> {
  await pool.query(
    `INSERT INTO ${quote(schema)}.queue_config
       (name, mode, target, payload, description, owner, concurrency)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO UPDATE SET
       mode = EXCLUDED.mode, target = EXCLUDED.target, payload = EXCLUDED.payload,
       description = EXCLUDED.description, owner = EXCLUDED.owner,
       concurrency = EXCLUDED.concurrency, updated_on = now()`,
    [
      spec.name,
      spec.mode,
      spec.target ? JSON.stringify(spec.target) : null,
      spec.payload,
      spec.description,
      spec.owner,
      spec.concurrency,
    ],
  );
}

export interface StoredQueueConfig {
  name: string;
  mode: QueueMode;
  target: Target | null;
  payload: PayloadMode;
  description: string;
  owner: string;
  concurrency: number;
}

export async function loadQueueConfigs(pool: Pool, schema: string): Promise<StoredQueueConfig[]> {
  const { rows } = await pool.query(
    `SELECT name, mode, target, payload, description, owner, concurrency
       FROM ${quote(schema)}.queue_config ORDER BY name`,
  );
  return rows as StoredQueueConfig[];
}

export async function deleteQueueConfig(pool: Pool, schema: string, name: string): Promise<void> {
  await pool.query(`DELETE FROM ${quote(schema)}.queue_config WHERE name = $1`, [name]);
}

/**
 * Schema names come from configuration, not from requests, but they are still
 * interpolated rather than parameterised — Postgres does not take an identifier
 * as a bind parameter. Quoting is the mitigation.
 */
function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new QueueError(`unusable schema name: ${identifier}`);
  }
  return `"${identifier}"`;
}
