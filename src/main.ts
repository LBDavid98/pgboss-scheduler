/**
 * Entrypoint.
 *
 * Order matters: pg-boss starts BEFORE the HTTP listener. A service that accepts
 * requests while its queue is still migrating answers 500s that look like bugs
 * in the caller.
 */

import { loadConfig } from "./config.ts";
import { Scheduler } from "./boss.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const bootLog = {
  info: (obj: object, msg?: string) => console.log(JSON.stringify({ level: "info", msg, ...obj })),
  warn: (obj: object, msg?: string) => console.warn(JSON.stringify({ level: "warn", msg, ...obj })),
  error: (obj: object, msg?: string) => console.error(JSON.stringify({ level: "error", msg, ...obj })),
  debug: (obj: object, msg?: string) => console.debug(JSON.stringify({ level: "debug", msg, ...obj })),
};

const scheduler = new Scheduler(config, bootLog);
await scheduler.start();

const app = buildServer(config, scheduler);
await app.listen({ port: config.port, host: config.host });

// SIGTERM is what `docker stop` sends. Draining rather than dropping means an
// in-flight delivery is not turned into an at-least-once retry the receiver
// never needed.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info({ signal }, "shutting down");
      await app.close();
      await scheduler.stop();
      process.exit(0);
    })();
  });
}
