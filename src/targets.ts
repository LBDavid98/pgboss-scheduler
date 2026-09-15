/**
 * Where a job goes when it comes due.
 *
 * Two kinds, and the second is the one that makes this service worth having
 * in a fleet that runs agents.
 *
 *   url    POST the payload to an HTTP endpoint. The general case.
 *   agent  Run an agent-runner agent. The scheduler translates the job into
 *          the runner's `POST /api/runs` body and treats any run status other
 *          than `ok` as a failure, so pg-boss retries it.
 *
 * WHY `agent` IS A KIND AND NOT JUST A URL. The runner's run API has a specific
 * body shape (`project_id`, `agent_id`, `input`, `capture`, `wait_ms`) and a
 * specific notion of failure: HTTP 200 with `status: "error"` is a FAILED job,
 * and a plain URL target would call that a success and never retry. Encoding
 * that here means "run this agent every morning" is a queue definition rather
 * than a webhook receiver somebody has to write and maintain in every app.
 */

export type TargetKind = "url" | "agent";

export interface UrlTarget {
  kind: "url";
  url: string;
  /** Extra headers for the receiver. Never a place for a secret — see below. */
  headers?: Record<string, string>;
}

export interface AgentTarget {
  kind: "agent";
  /** The design's path in the project without the suffix: `agents/qa-draft`. */
  agent_id: string;
  project?: string;
  /** `full` keeps the answer; `digest`/`redacted` deliberately keep none. */
  capture?: "full" | "digest" | "redacted";
  max_cost_usd?: number;
}

export type Target = UrlTarget | AgentTarget;

/**
 * How much of the job to put in the request body.
 *
 *   envelope  the full envelope shape — {queue, job_id, data, context, ...}.
 *             The default, and what a receiver you control should expect.
 *   data      the job's `data` verbatim, and nothing else.
 *
 * `data` exists for FOREIGN RECEIVERS that have their own body format and will
 * not learn ours — ntfy's JSON publish endpoint is the motivating case, and
 * Slack-style webhooks are the same shape of problem. Without it, every such
 * receiver needs a translating shim service in front of it. The delivery headers
 * still carry the job id, queue and trace id either way, so nothing is lost that
 * an envelope-aware receiver needs.
 */
export type PayloadMode = "envelope" | "data";

const SAFE_URL = /^https?:\/\//i;

/** Header names a caller may not set, because delivery owns their meaning. */
const RESERVED_HEADERS = new Set([
  "authorization",
  "content-type",
  "x-app-signature",
  "x-app-job-id",
  "x-app-queue",
  "x-app-trace-id",
  "x-app-delivery",
]);

export class TargetError extends Error {}

/**
 * Validate and normalise a target from the API.
 *
 * A queue in `pull` mode has no target: nothing is delivered, the consumer
 * fetches. Passing one is a mistake worth a 400 rather than a silently ignored
 * field that somebody later swears was configured.
 */
export function parseTarget(raw: unknown): Target {
  if (typeof raw === "string") {
    return parseTarget({ kind: "url", url: raw });
  }
  if (!raw || typeof raw !== "object") {
    throw new TargetError("target must be a URL string or an object with a `kind`");
  }
  const target = raw as Record<string, unknown>;
  const kind = target.kind ?? "url";

  if (kind === "url") {
    const url = String(target.url ?? "");
    if (!SAFE_URL.test(url)) {
      throw new TargetError(`target.url must start with http:// or https:// — got ${url || "nothing"}`);
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(target.headers || {})) {
      if (RESERVED_HEADERS.has(key.toLowerCase())) {
        // Refused rather than dropped. A caller who sets `authorization` here
        // believes the delivery is authenticated by it; dropping it silently
        // leaves them believing that.
        throw new TargetError(
          `target.headers may not set ${key} — delivery owns that header. ` +
            "A receiver that needs its own credential should read it from its own environment.",
        );
      }
      headers[key] = String(value);
    }
    return { kind: "url", url, ...(Object.keys(headers).length ? { headers } : {}) };
  }

  if (kind === "agent") {
    const agentId = String(target.agent_id ?? "");
    if (!agentId) throw new TargetError("an agent target needs `agent_id`, e.g. agents/qa-draft");
    const capture = (target.capture as AgentTarget["capture"]) ?? "full";
    if (!["full", "digest", "redacted"].includes(capture)) {
      throw new TargetError(`target.capture must be full, digest or redacted — got ${capture}`);
    }
    return {
      kind: "agent",
      agent_id: agentId,
      ...(target.project ? { project: String(target.project) } : {}),
      capture,
      ...(target.max_cost_usd != null ? { max_cost_usd: Number(target.max_cost_usd) } : {}),
    };
  }

  throw new TargetError(`unknown target kind: ${String(kind)} — expected url or agent`);
}
