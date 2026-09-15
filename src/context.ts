/**
 * The context envelope — the reason this is a App service and not a
 * generic pg-boss wrapper.
 *
 * Every job carries `{trace_id, actor, project, cause}`. The trace id is minted
 * here when the caller does not supply one, travels with the job through the
 * queue, goes out on the delivery as `X-App-Trace-Id`, and appears in every
 * log line about that job.
 *
 * WHY IT MATTERS HERE SPECIFICALLY. a typed client result already carries a
 * `trace_id`, and your fleet already ships container logs to Loki. So one id
 * follows a unit of work from the schedule that created it, through the
 * delivery, into the agent run it triggered — across three containers, in one
 * Grafana query. The thing this replaces (a peer app's JSON run log)
 * records that a job ran and nothing about what it did.
 *
 * The envelope is stored ALONGSIDE the caller's data rather than merged into it,
 * under a reserved key. Merging would mean a caller with a `project` field of
 * their own silently loses it.
 */

import { randomUUID } from "node:crypto";

/** The reserved key. Job data is the caller's; this is ours. */
export const ENVELOPE_KEY = "__envelope__";

export interface Context {
  trace_id: string;
  /** Who asked for this. The token's caller name when the caller says nothing. */
  actor: string;
  /** Free-form: which app or project this work belongs to. */
  project?: string;
  /** Why this exists — "daily 08:00 ping", "retry of run-abc". Human-readable. */
  cause?: string;
}

export interface Envelope {
  context: Context;
  /** The queue's caller name at enqueue time, which the caller cannot forge. */
  enqueued_by: string;
  enqueued_at: string;
}

export interface ContextInput {
  trace_id?: string;
  actor?: string;
  project?: string;
  cause?: string;
}

/**
 * Build the envelope for a job.
 *
 * `enqueuedBy` comes from the bearer token, NOT from the request body, so job
 * history cannot be made to lie about who scheduled something. `context.actor`
 * is caller-supplied and may legitimately differ — a service scheduling work on
 * behalf of a person sets actor to the person and is still recorded as itself.
 */
export function buildEnvelope(input: ContextInput | undefined, enqueuedBy: string): Envelope {
  return {
    context: {
      trace_id: input?.trace_id || randomUUID(),
      actor: input?.actor || enqueuedBy,
      ...(input?.project ? { project: input.project } : {}),
      ...(input?.cause ? { cause: input.cause } : {}),
    },
    enqueued_by: enqueuedBy,
    enqueued_at: new Date().toISOString(),
  };
}

/** Caller data plus our envelope, ready to hand to pg-boss. */
export function pack(data: Record<string, unknown> | undefined, envelope: Envelope) {
  return { ...(data || {}), [ENVELOPE_KEY]: envelope };
}

/** The inverse: the caller's data, and the envelope, separated again. */
export function unpack(stored: Record<string, unknown> | null | undefined): {
  data: Record<string, unknown>;
  envelope: Envelope | null;
} {
  if (!stored || typeof stored !== "object") return { data: {}, envelope: null };
  const { [ENVELOPE_KEY]: envelope, ...data } = stored;
  return {
    data: data as Record<string, unknown>,
    envelope: (envelope as Envelope) || null,
  };
}
