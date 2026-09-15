/**
 * Handing a due job to whatever has to run it.
 *
 * THE CONTRACT WITH pg-boss: this module signals failure by THROWING. pg-boss
 * treats a thrown handler as a failed job and applies the queue's retry policy;
 * returning normally completes it. So every "the receiver did not accept this"
 * path below must throw, and the error message must say enough to diagnose it
 * from a job row alone — the receiver's status and the first part of its body.
 *
 * DELIVERY IS AT-LEAST-ONCE, and that is not a defect to be worked around. A
 * receiver that does the work and then times out will be called again, because
 * from here those two cases are indistinguishable. `X-App-Job-Id` is stable
 * across every attempt at the same job precisely so a receiver can dedupe on it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";
import { type Envelope, unpack } from "./context.ts";
import type { QueueSpec } from "./queues.ts";

/** `sha256=<hex>` over the exact bytes sent. */
export function sign(body: string, key: string): string {
  return "sha256=" + createHmac("sha256", key).update(body, "utf8").digest("hex");
}

/**
 * What a receiver should call. Exported and tested here so the documented
 * verification recipe and the thing that produces the signature cannot drift.
 */
export function verify(body: string, key: string, presented: string): boolean {
  const expected = Buffer.from(sign(body, key));
  const actual = Buffer.from(presented || "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface DeliverableJob {
  id: string;
  name: string;
  data: Record<string, unknown> | null;
  /** pg-boss's retry count, present because workers ask for metadata. */
  retryCount?: number;
}

export interface DeliveryOutcome {
  status: number;
  /** Set for an agent target: the runner's run id, so the run is findable. */
  run_id?: string;
  trace_id: string;
  duration_ms: number;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly trace_id: string,
  ) {
    super(message);
  }
}

export async function deliver(
  job: DeliverableJob,
  spec: QueueSpec,
  config: Config,
): Promise<DeliveryOutcome> {
  const { data, envelope } = unpack(job.data);
  const attempt = (job.retryCount ?? 0) + 1;
  const traceId = envelope?.context.trace_id || job.id;

  if (!spec.target) {
    // Unreachable through the API — a push queue cannot be saved without one —
    // but reachable if the config table is edited by hand, which is exactly when
    // a clear message is worth having.
    throw new DeliveryError(`queue ${spec.name} is push but has no target`, null, traceId);
  }

  const started = Date.now();
  if (spec.target.kind === "agent") {
    return await deliverToAgent(job, data, envelope, spec, config, traceId, started);
  }

  const body =
    spec.payload === "data"
      ? JSON.stringify(data)
      : JSON.stringify({
          queue: job.name,
          job_id: job.id,
          delivery: attempt,
          data,
          context: envelope?.context ?? null,
          enqueued_by: envelope?.enqueued_by ?? null,
          enqueued_at: envelope?.enqueued_at ?? null,
        });

  const response = await post(spec.target.url, body, {
    "content-type": "application/json",
    "x-app-signature": sign(body, config.signingKey),
    "x-app-job-id": job.id,
    "x-app-queue": job.name,
    "x-app-trace-id": traceId,
    "x-app-delivery": String(attempt),
    ...(spec.target.headers || {}),
  }, config.deliveryTimeoutMs, traceId);

  if (!response.ok) {
    throw new DeliveryError(
      `${spec.target.url} answered ${response.status}: ${excerpt(response.body)}`,
      response.status,
      traceId,
    );
  }
  return { status: response.status, trace_id: traceId, duration_ms: Date.now() - started };
}

/**
 * An agent target, translated into the runner's run API.
 *
 * THE SUBTLE PART: the runner answers HTTP 200 for a run that FAILED — the run
 * row carries the status. A plain url target would call that a success and never
 * retry, which is the whole reason `agent` is its own kind rather than a URL
 * somebody types into the target field.
 */
async function deliverToAgent(
  job: DeliverableJob,
  data: Record<string, unknown>,
  envelope: Envelope | null,
  spec: QueueSpec,
  config: Config,
  traceId: string,
  started: number,
): Promise<DeliveryOutcome> {
  const target = spec.target as Extract<QueueSpec["target"], { kind: "agent" }>;
  // The studio refuses to hold a request open longer than 600s, the same cap
  // a well-behaved client applies. Asking for more gets the request rejected outright.
  const waitMs = Math.min(config.agentTimeoutMs, 600_000);
  const body = JSON.stringify({
    project_id: target.project || config.agentRunnerProject,
    agent_id: target.agent_id,
    input: data,
    capture: target.capture || "full",
    wait_ms: waitMs,
    ...(target.max_cost_usd != null ? { max_cost_usd: target.max_cost_usd } : {}),
  });

  const response = await post(
    `${config.agentRunnerUrl.replace(/\/$/, "")}/api/runs`,
    body,
    {
      "content-type": "application/json",
      "x-app-trace-id": traceId,
    },
    // A little longer than the runner's own wait, so a run that uses its full
    // budget is not cut off by our timeout a moment before it answers.
    waitMs + 15_000,
    traceId,
  );

  if (!response.ok) {
    throw new DeliveryError(
      `agent-runner answered ${response.status}: ${excerpt(response.body)}`,
      response.status,
      traceId,
    );
  }

  let run: Record<string, unknown>;
  try {
    run = JSON.parse(response.body || "{}");
  } catch {
    throw new DeliveryError(`agent-runner answered with non-JSON: ${excerpt(response.body)}`, 200, traceId);
  }

  const status = String(run.status ?? "unknown");
  if (status !== "ok") {
    throw new DeliveryError(
      `run ${String(run.run_id ?? "?")} for ${target.agent_id} ended ${status}: ` +
        `${String(run.outcome ?? "no outcome given")}`,
      null,
      traceId,
    );
  }
  return {
    status: response.status,
    run_id: String(run.run_id ?? ""),
    // The studio's trace id when it has one — that is the id the run is
    // findable by in the runner's own span capture.
    trace_id: String(run.trace_id || traceId),
    duration_ms: Date.now() - started,
  };
}

interface RawResponse {
  ok: boolean;
  status: number;
  body: string;
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  traceId: string,
): Promise<RawResponse> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      // Never follow a redirect. The same reasoning a careful client
      // documents: a 302 turns "your token is missing" into a fetch of a login
      // page and a parse error a long way from the cause.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Name the address. "fetch failed" with no target is the least useful
    // message in this stack.
    throw new DeliveryError(`could not reach ${url}: ${reason}`, null, traceId);
  }
}

/** Enough of a receiver's answer to diagnose it, never enough to be a payload. */
function excerpt(body: string): string {
  const flat = (body || "").replace(/\s+/g, " ").trim();
  return flat.length > 300 ? flat.slice(0, 300) + "…" : flat || "(empty body)";
}
