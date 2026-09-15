/**
 * Configuration, read once at boot and never re-read.
 *
 * Every value that is a SECRET is read from the environment and nowhere else —
 * there is no config file holding a token, because a config file gets committed
 * eventually. `compose.yml` loads these from a 0600 `.env` that is gitignored.
 *
 * The process REFUSES TO BOOT on a missing secret rather than starting and
 * failing on first use. A scheduler that comes up healthy and then cannot sign a
 * delivery is worse than one that never came up: the first is discovered by a
 * job silently not arriving, the second by looking at the logs once.
 */

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** pg-boss owns this schema. Our own tables live in `schedulerSchema`. */
  bossSchema: string;
  schedulerSchema: string;
  /** token -> caller name. The NAME is what gets recorded on a job. */
  tokens: Map<string, string>;
  signingKey: string;
  /** Where an `agent` target is sent. The mesh studio, not the 503 tombstone. */
  agentRunnerUrl: string;
  agentRunnerProject: string;
  /** How long a push delivery may take before it counts as failed. */
  deliveryTimeoutMs: number;
  /** How long an agent run may take. Agents are slow; deliveries are not. */
  agentTimeoutMs: number;
  logLevel: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. It has no default on purpose — see .env.example.`,
    );
  }
  return value;
}

/**
 * `name:token,name:token`. Parsed into token -> name so a request costs one map
 * lookup, and so the same name may hold several tokens during a rotation.
 */
function parseTokens(raw: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    if (at < 1 || at === trimmed.length - 1) {
      throw new Error(
        "SCHEDULER_TOKENS must be name:token pairs separated by commas. " +
          "One entry was missing its colon; the value is not echoed here.",
      );
    }
    tokens.set(trimmed.slice(at + 1), trimmed.slice(0, at));
  }
  if (tokens.size === 0) {
    throw new Error("SCHEDULER_TOKENS parsed to zero callers — nothing could authenticate.");
  }
  return tokens;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const signingKey = required(env, "SCHEDULER_SIGNING_KEY");
  // 32 hex characters is 16 bytes. Shorter than that and the HMAC is decoration.
  if (signingKey.length < 32) {
    throw new Error(
      "SCHEDULER_SIGNING_KEY is shorter than 32 characters. Generate one with " +
        "`openssl rand -hex 32`; a short key makes the signature a formality.",
    );
  }
  return {
    port: Number(env.PORT || 8020),
    // 0.0.0.0 because Docker's own proxy dials the container IP. 127.0.0.1 here
    // would make the service unreachable from every peer on the network.
    host: env.HOST || "0.0.0.0",
    databaseUrl: required(env, "DATABASE_URL"),
    bossSchema: env.SCHEDULER_BOSS_SCHEMA || "pgboss",
    schedulerSchema: env.SCHEDULER_SCHEMA || "scheduler",
    tokens: parseTokens(required(env, "SCHEDULER_TOKENS")),
    signingKey,
    // The agent runner. The SDK's own default (8011) is the stubbed standalone
    // that answers 503, and 8010 on the mesh network is the live one.
    agentRunnerUrl: env.AGENT_RUNNER_URL || "http://agent-runner:8010",
    agentRunnerProject: env.AGENT_RUNNER_PROJECT || "agent-runner",
    deliveryTimeoutMs: Number(env.SCHEDULER_DELIVERY_TIMEOUT_MS || 30_000),
    agentTimeoutMs: Number(env.SCHEDULER_AGENT_TIMEOUT_MS || 300_000),
    logLevel: env.LOG_LEVEL || "info",
  };
}
