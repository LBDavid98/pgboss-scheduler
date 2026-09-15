/**
 * A real Postgres, a real pg-boss, a real HTTP receiver.
 *
 * A THROWAWAY CONTAINER, not your fleet's Postgres. These tests create queues,
 * fail jobs deliberately and drop schemas; pointing them at the shared instance
 * would put test queues next to Foreman's and a peer app's data, and one
 * mistyped schema name would be somebody's afternoon.
 *
 * Mocking pg-boss instead would test the mock. Everything worth knowing here —
 * that a retry actually backs off, that an exhausted job actually lands in the
 * dead-letter queue, that a cron schedule is actually registered — lives in
 * pg-boss's own tables.
 */

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import pg from "pg";
import { Scheduler } from "../../src/boss.ts";
import { type Config, loadConfig } from "../../src/config.ts";
import { buildServer } from "../../src/server.ts";

const run = promisify(execFile);

export const SIGNING_KEY = "0123456789abcdef0123456789abcdef";
export const TOKEN = "tok-test-aaaabbbbcccc";

let container = "";

/** Start Postgres in a container and wait until it actually accepts queries. */
export async function startPostgres(): Promise<string> {
  container = `scheduler-test-pg-${process.pid}`;
  const { stdout } = await run("docker", [
    "run", "-d", "--rm",
    "--name", container,
    "-e", "POSTGRES_PASSWORD=test",
    "-e", "POSTGRES_USER=test",
    "-e", "POSTGRES_DB=scheduler_test",
    // A random host port: the suite must not collide with anything on your fleet,
    // and must not assume 5432 is free.
    "-p", "127.0.0.1:0:5432",
    "postgres:17-alpine",
  ]);
  const id = stdout.trim();

  const { stdout: portOut } = await run("docker", ["port", id, "5432/tcp"]);
  const port = portOut.trim().split("\n")[0].split(":").pop();
  const url = `postgres://test:test@127.0.0.1:${port}/scheduler_test`;

  // A REAL QUERY FROM THE HOST, not `pg_isready` inside the container.
  // During initdb, Postgres runs a temporary server that pg_isready reports as
  // ready and that then goes away — connecting on that signal gets ECONNRESET a
  // moment later, which is exactly the flake this loop exists to prevent.
  for (let attempt = 0; attempt < 120; attempt++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return url;
    } catch {
      await client.end().catch(() => {});
      await sleep(500);
    }
  }
  throw new Error(`the test Postgres never became reachable at ${url}`);
}

export async function stopPostgres(): Promise<void> {
  if (container) await run("docker", ["rm", "-f", container]).catch(() => {});
  container = "";
}

export function testConfig(databaseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      SCHEDULER_TOKENS: `test-caller:${TOKEN}`,
      SCHEDULER_SIGNING_KEY: SIGNING_KEY,
      LOG_LEVEL: "silent",
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export interface Harness {
  scheduler: Scheduler;
  app: ReturnType<typeof buildServer>;
  /** Fastify's inject: a real request through the real stack, no socket needed. */
  call: (
    method: string,
    url: string,
    body?: unknown,
    token?: string | null,
  ) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
}

export async function startHarness(config: Config): Promise<Harness> {
  const scheduler = new Scheduler(config, quiet);
  await scheduler.start();
  const app = buildServer(config, scheduler);
  await app.ready();

  return {
    scheduler,
    app,
    async call(method, url, body, token = TOKEN) {
      const response = await app.inject({
        method: method as never,
        url,
        ...(body === undefined ? {} : { payload: body as object }),
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      let parsed: unknown = null;
      try {
        parsed = response.body ? JSON.parse(response.body) : null;
      } catch {
        parsed = response.body;
      }
      return { status: response.statusCode, body: parsed };
    },
    async stop() {
      await app.close();
      await scheduler.stop();
    },
  };
}

export interface Receiver {
  url: string;
  /** Every request seen, in order, with headers and raw body. */
  received: { headers: Record<string, string>; body: string }[];
  /** Answer the next N requests with this status. */
  respondWith: (status: number, body?: string) => void;
  close: () => Promise<void>;
}

/** A real HTTP receiver on a real port — deliveries actually go over TCP. */
export async function startReceiver(): Promise<Receiver> {
  let status = 200;
  let responseBody = '{"ok":true}';
  const received: Receiver["received"] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(responseBody);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    respondWith(next, body = '{"ok":true}') {
      status = next;
      responseBody = body;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` is true, or fail with what was actually seen. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  describe: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe}`);
}
