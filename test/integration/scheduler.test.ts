/**
 * The service, end to end, against a real Postgres and a real receiver.
 *
 * What these protect is the behaviour that is silent when it is wrong: a job
 * that is never delivered, a retry that never happens, a dead letter that goes
 * nowhere, a push queue that a second consumer quietly races.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { verify } from "../../src/delivery.ts";
import {
  type Harness,
  type Receiver,
  SIGNING_KEY,
  TOKEN,
  eventually,
  startHarness,
  startPostgres,
  startReceiver,
  stopPostgres,
  testConfig,
} from "./harness.ts";

let harness: Harness;
let receiver: Receiver;
let databaseUrl: string;

before(async () => {
  databaseUrl = await startPostgres();
  harness = await startHarness(testConfig(databaseUrl));
  receiver = await startReceiver();
});

after(async () => {
  await harness?.stop();
  await receiver?.close();
  await stopPostgres();
});

describe("auth", () => {
  it("refuses a call with no token, and says what the token is", async () => {
    const { status, body } = await harness.call("POST", "/v1/queues", { name: "a.b" }, null);
    assert.equal(status, 401);
    assert.match(body.detail, /SCHEDULER_TOKENS/);
  });

  it("refuses a token that is not ours", async () => {
    const { status } = await harness.call("GET", "/v1/queues", undefined, "tok-not-ours");
    assert.equal(status, 401);
  });

  it("leaves the open routes open, because the deploy script and Prometheus use them", async () => {
    for (const path of ["/", "/healthz", "/readyz", "/metrics"]) {
      const { status } = await harness.call("GET", path, undefined, null);
      assert.equal(status, 200, `${path} answered ${status}`);
    }
  });
});

describe("queues", () => {
  it("creates a queue, its dead-letter queue, and reports both back", async () => {
    const { status, body } = await harness.call("POST", "/v1/queues", {
      name: "test.basic",
      target: receiver.url,
      description: "the smoke queue",
    });
    assert.equal(status, 201);
    assert.equal(body.queue.mode, "push");
    assert.equal(body.queue.deadLetter, "test.basic.dlq");
    assert.equal(body.queue.owner, "test-caller");

    // The dead-letter queue must really exist, or pg-boss cannot move a job to it.
    const dlq = await harness.call("GET", "/v1/queues/test.basic.dlq");
    assert.equal(dlq.status, 200);
  });

  it("is idempotent — the same spec twice is not an error", async () => {
    const spec = { name: "test.idempotent", target: receiver.url };
    assert.equal((await harness.call("POST", "/v1/queues", spec)).status, 201);
    assert.equal((await harness.call("POST", "/v1/queues", spec)).status, 201);
  });

  it("refuses to change a policy in place, and says what to do instead", async () => {
    // pg-boss's updateQueue cannot change a policy. Silently ignoring the new
    // value would leave the API reporting a policy the queue does not have.
    await harness.call("POST", "/v1/queues", { name: "test.policy", target: receiver.url });
    const { status, body } = await harness.call("POST", "/v1/queues", {
      name: "test.policy",
      target: receiver.url,
      policy: "singleton",
    });
    assert.equal(status, 409);
    assert.match(body.detail, /Delete the queue and recreate it/);
  });

  it("404s a queue that does not exist rather than inventing one", async () => {
    assert.equal((await harness.call("GET", "/v1/queues/test.ghost")).status, 404);
    const job = await harness.call("POST", "/v1/jobs", { queue: "test.ghost", data: {} });
    assert.equal(job.status, 404);
    assert.match(job.body.detail, /create it first/);
  });
});

describe("push delivery", () => {
  it("delivers an enqueued job, signed, with the context envelope intact", async () => {
    await harness.call("POST", "/v1/queues", { name: "test.push", target: receiver.url });
    const before = receiver.received.length;

    const { status, body } = await harness.call("POST", "/v1/jobs", {
      queue: "test.push",
      data: { hello: "world" },
      context: { actor: "ops", cause: "an integration test" },
    });
    assert.equal(status, 201);
    const traceId = body.context.trace_id;

    await eventually(() => receiver.received.length > before, "the job to be delivered");
    const delivery = receiver.received[receiver.received.length - 1];

    // The signature must verify with the recipe the docs give receivers.
    assert.equal(
      verify(delivery.body, SIGNING_KEY, delivery.headers["x-app-signature"]),
      true,
      "the delivered body did not verify against its own signature",
    );

    assert.equal(delivery.headers["x-app-queue"], "test.push");
    assert.equal(delivery.headers["x-app-trace-id"], traceId);
    assert.equal(delivery.headers["x-app-delivery"], "1");
    assert.ok(delivery.headers["x-app-job-id"], "no job id header to dedupe on");

    const payload = JSON.parse(delivery.body);
    assert.deepEqual(payload.data, { hello: "world" });
    assert.equal(payload.context.actor, "ops");
    assert.equal(payload.context.cause, "an integration test");
    // enqueued_by comes from the token, so it names the service, not the person.
    assert.equal(payload.enqueued_by, "test-caller");
    // The envelope must not leak into the caller's data.
    assert.equal("__envelope__" in payload.data, false);
  });

  it("sends only the caller's data when the queue asks for payload: data", async () => {
    // The ntfy case: a receiver with its own body format that will not learn ours.
    await harness.call("POST", "/v1/queues", {
      name: "test.raw",
      target: receiver.url,
      payload: "data",
    });
    const before = receiver.received.length;
    await harness.call("POST", "/v1/jobs", {
      queue: "test.raw",
      data: { topic: "app-alerts", message: "morning" },
    });

    await eventually(() => receiver.received.length > before, "the raw job to be delivered");
    const delivery = receiver.received[receiver.received.length - 1];
    assert.deepEqual(JSON.parse(delivery.body), { topic: "app-alerts", message: "morning" });
    // The metadata still travels — in headers, where a foreign receiver ignores it.
    assert.equal(delivery.headers["x-app-queue"], "test.raw");
    assert.ok(delivery.headers["x-app-job-id"]);
  });

  it("retries a rejected delivery and dead-letters it once the retries run out", async () => {
    await harness.call("POST", "/v1/queues", {
      name: "test.failing",
      target: receiver.url,
      retryLimit: 1,
      // No backoff and no delay, so the test does not wait 60s for a retry it
      // is only checking the existence of.
      retryDelay: 0,
      retryBackoff: false,
    });
    receiver.respondWith(500, '{"detail":"receiver is unhappy"}');
    const before = receiver.received.length;

    await harness.call("POST", "/v1/jobs", { queue: "test.failing", data: { n: 1 } });

    // retryLimit 1 means two attempts in total.
    await eventually(
      () => receiver.received.length >= before + 2,
      "the delivery to be attempted twice",
    );
    const attempts = receiver.received.slice(before);
    assert.equal(attempts[0].headers["x-app-delivery"], "1");
    assert.equal(attempts[1].headers["x-app-delivery"], "2");
    // The job id is STABLE across attempts — that is what makes it usable as an
    // idempotency key by a receiver that did the work before timing out.
    assert.equal(
      attempts[0].headers["x-app-job-id"],
      attempts[1].headers["x-app-job-id"],
    );

    // And the exhausted job lands somewhere a person can find it.
    //
    // FETCHED rather than counted: a queue's counts come from pg-boss's
    // monitoring pass, which runs on an interval, so a stats call right after
    // the failure reports zero for reasons that have nothing to do with whether
    // the job arrived. Fetching asks the table directly.
    await eventually(async () => {
      const { body } = await harness.call("POST", "/v1/queues/test.failing.dlq/fetch", {});
      return body.jobs.length > 0;
    }, "the exhausted job to reach the dead-letter queue");

    receiver.respondWith(200);
  });
});

describe("pull mode", () => {
  it("hands a job to a consumer that fetches, and completes it", async () => {
    await harness.call("POST", "/v1/queues", { name: "test.pull", mode: "pull" });
    const created = await harness.call("POST", "/v1/jobs", {
      queue: "test.pull",
      data: { work: "to do" },
    });
    assert.equal(created.status, 201);

    const fetched = await harness.call("POST", "/v1/queues/test.pull/fetch", { batch_size: 5 });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.jobs.length, 1);
    const job = fetched.body.jobs[0];
    assert.deepEqual(job.data, { work: "to do" });
    assert.equal(job.enqueued_by, "test-caller");
    assert.ok(job.context.trace_id);

    const completed = await harness.call("POST", `/v1/jobs/test.pull/${job.id}/complete`, {
      output: { done: true },
    });
    assert.equal(completed.body.completed, 1);

    // Nothing left to fetch — the job was claimed and finished, not re-offered.
    const again = await harness.call("POST", "/v1/queues/test.pull/fetch", {});
    assert.equal(again.body.jobs.length, 0);
  });

  it("refuses to let a consumer fetch from a push queue", async () => {
    // Both would be pulling the same jobs, and some would be delivered twice
    // for no reason at all.
    await harness.call("POST", "/v1/queues", { name: "test.nofetch", target: receiver.url });
    const { status, body } = await harness.call("POST", "/v1/queues/test.nofetch/fetch", {});
    assert.equal(status, 409);
    assert.match(body.detail, /is a push queue/);
  });
});

describe("schedules", () => {
  it("registers a cron schedule with an explicit timezone and reads it back", async () => {
    await harness.call("POST", "/v1/queues", { name: "test.cron", target: receiver.url });
    const { status, body } = await harness.call("POST", "/v1/schedules", {
      queue: "test.cron",
      cron: "0 8 * * *",
      tz: "America/New_York",
      key: "morning",
      data: { message: "good morning" },
      context: { cause: "the daily ping" },
    });
    assert.equal(status, 201);
    assert.equal(body.schedule.tz, "America/New_York");

    const list = await harness.call("GET", "/v1/schedules?queue=test.cron");
    const found = list.body.schedules.find((s: { key: string }) => s.key === "morning");
    assert.ok(found, "the schedule was not read back");
    assert.equal(found.cron, "0 8 * * *");
    assert.equal(found.tz, "America/New_York");
    // The caller's data comes back as the caller's data, envelope separated.
    assert.deepEqual(found.data, { message: "good morning" });
    assert.equal(found.context.cause, "the daily ping");
  });

  it("defaults to America/New_York rather than UTC", async () => {
    // Defaulting to UTC would make "every morning at 8" arrive at 3am for half
    // the year, and the caller would have no reason to suspect the scheduler.
    await harness.call("POST", "/v1/queues", { name: "test.cron-tz", target: receiver.url });
    const { body } = await harness.call("POST", "/v1/schedules", {
      queue: "test.cron-tz",
      cron: "0 8 * * *",
    });
    assert.equal(body.schedule.tz, "America/New_York");
  });

  it("gives each run of a schedule its own trace, not one frozen at registration", async () => {
    // The envelope is built once and stored in the schedule, so a minted trace
    // id would stamp every future run identically — making "find this run in
    // Grafana" return every run there has ever been. Each occurrence must be
    // individually traceable.
    await harness.call("POST", "/v1/queues", { name: "test.cron-trace", target: receiver.url });
    const { body } = await harness.call("POST", "/v1/schedules", {
      queue: "test.cron-trace", cron: "*/5 * * * *", key: "t",
    });
    assert.equal(body.context.trace_id, "", "a schedule must not freeze a trace id");

    const list = await harness.call("GET", "/v1/schedules?queue=test.cron-trace");
    const found = list.body.schedules.find((s: { key: string }) => s.key === "t");
    assert.ok(!found.context?.trace_id, "the stored schedule still carries a frozen trace");
  });

  it("honours a trace id the caller deliberately supplied", async () => {
    // Correlating a whole schedule under one id is a legitimate thing to want;
    // it just must not be the default.
    await harness.call("POST", "/v1/queues", { name: "test.cron-fixed", target: receiver.url });
    const { body } = await harness.call("POST", "/v1/schedules", {
      queue: "test.cron-fixed", cron: "*/5 * * * *", key: "t",
      context: { trace_id: "deliberately-fixed" },
    });
    assert.equal(body.context.trace_id, "deliberately-fixed");
  });

  it("removes a schedule", async () => {
    await harness.call("POST", "/v1/queues", { name: "test.cron-gone", target: receiver.url });
    await harness.call("POST", "/v1/schedules", {
      queue: "test.cron-gone",
      cron: "*/5 * * * *",
      key: "temp",
    });
    assert.equal((await harness.call("DELETE", "/v1/schedules/test.cron-gone/temp")).status, 204);
    const list = await harness.call("GET", "/v1/schedules?queue=test.cron-gone");
    assert.equal(list.body.schedules.length, 0);
  });

  it("refuses a schedule for a queue that does not exist", async () => {
    const { status } = await harness.call("POST", "/v1/schedules", {
      queue: "test.never-made",
      cron: "0 8 * * *",
    });
    assert.equal(status, 404);
  });
});

describe("job inspection", () => {
  it("finds a job by id and reports who enqueued it", async () => {
    await harness.call("POST", "/v1/queues", { name: "test.inspect", mode: "pull" });
    const { body } = await harness.call("POST", "/v1/jobs", {
      queue: "test.inspect",
      data: { a: 1 },
      // startAfter far enough out that the job is still queued when we look.
      options: { startAfter: 3600 },
    });
    const found = await harness.call("GET", `/v1/jobs/test.inspect/${body.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.job.enqueued_by, "test-caller");
    assert.deepEqual(found.body.job.data, { a: 1 });
  });

  it("cancels a queued job", async () => {
    await harness.call("POST", "/v1/queues", { name: "test.cancel", mode: "pull" });
    const { body } = await harness.call("POST", "/v1/jobs", {
      queue: "test.cancel",
      data: {},
      options: { startAfter: 3600 },
    });
    const cancelled = await harness.call("POST", `/v1/jobs/test.cancel/${body.id}/cancel`);
    assert.equal(cancelled.body.updated, 1);
  });

  it("reports a throttled send as suppressed, not as a success or an error", async () => {
    // pg-boss returns null when a throttle rule swallows a send. Reporting that
    // as a created job would be a lie; reporting it as an error would have
    // callers retrying something that is working exactly as configured.
    //
    // NOTE singletonSeconds, not singletonKey alone: on a `standard` queue a
    // bare singletonKey does not deduplicate — that needs the `singleton` or
    // `stately` policy. The throttle window is what suppresses here, and it is
    // the mechanism the WordPress rebuild loop uses to collapse ten edits in a
    // minute into one rebuild.
    await harness.call("POST", "/v1/queues", { name: "test.singleton", mode: "pull" });
    const first = await harness.call("POST", "/v1/jobs", {
      queue: "test.singleton",
      data: {},
      options: { singletonKey: "only-one", singletonSeconds: 300 },
    });
    assert.equal(first.status, 201);

    const second = await harness.call("POST", "/v1/jobs", {
      queue: "test.singleton",
      data: {},
      options: { singletonKey: "only-one", singletonSeconds: 300 },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.suppressed, true);
    assert.equal(second.body.id, null);
  });
});

describe("permanent versus transient failure", () => {
  it("does not spend retries on a 4xx, and dead-letters it immediately", async () => {
    // Retrying sends byte-identical bytes to the same URL. If the receiver
    // called the request malformed the first time it will every time, so the
    // retries add delay and log noise and no information.
    await harness.call("POST", "/v1/queues", {
      name: "test.rejected", target: receiver.url, retryLimit: 3, retryDelay: 0,
    });
    receiver.respondWith(400, '{"error":"unknown_job"}');
    const before = receiver.received.length;

    await harness.call("POST", "/v1/jobs", { queue: "test.rejected", data: { n: 1 } });

    await eventually(async () => {
      const { body } = await harness.call("POST", "/v1/queues/test.rejected.dlq/fetch", {});
      return body.jobs.length > 0;
    }, "the rejected job to be dead-lettered");

    // ONE attempt, not four. This is the whole point.
    assert.equal(
      receiver.received.length - before, 1,
      "a 4xx must not be retried — the receiver should have been called exactly once",
    );
    receiver.respondWith(200);
  });

  it("still retries a 5xx, which may be transient", async () => {
    await harness.call("POST", "/v1/queues", {
      name: "test.transient", target: receiver.url, retryLimit: 1, retryDelay: 0,
      retryBackoff: false,
    });
    receiver.respondWith(500, '{"detail":"receiver is briefly unhappy"}');
    const before = receiver.received.length;

    await harness.call("POST", "/v1/jobs", { queue: "test.transient", data: { n: 1 } });

    await eventually(
      () => receiver.received.length >= before + 2,
      "a 5xx to be retried",
    );
    receiver.respondWith(200);
  });
});

describe("singleton windows", () => {
  it("drops a throttled job, but DEFERS one asking for the next slot", async () => {
    // The distinction that cost an afternoon. singletonSeconds alone throttles:
    // the second job inside the window is discarded and never runs. For "ping
    // me at most once an hour" that is correct. For "rebuild the site after a
    // publish" it means an editor who fixes a typo 30 seconds later has their
    // fix silently thrown away and the live site stays stale.
    //
    // singletonNextSlot defers instead, so a burst still collapses to one run
    // and the LAST state is the one that gets built.
    await harness.call("POST", "/v1/queues", { name: "test.slots", mode: "pull" });

    const first = await harness.call("POST", "/v1/jobs", {
      queue: "test.slots", data: { n: 1 },
      options: { singletonKey: "k", singletonSeconds: 300 },
    });
    assert.equal(first.status, 201, "the first job in a window is always created");

    const dropped = await harness.call("POST", "/v1/jobs", {
      queue: "test.slots", data: { n: 2 },
      options: { singletonKey: "k", singletonSeconds: 300 },
    });
    assert.equal(dropped.body.suppressed, true, "a throttled job should be dropped");
    assert.equal(dropped.body.id, null);

    const deferred = await harness.call("POST", "/v1/jobs", {
      queue: "test.slots", data: { n: 3 },
      options: { singletonKey: "k", singletonSeconds: 300, singletonNextSlot: true },
    });
    assert.equal(deferred.status, 201, "singletonNextSlot must defer, not drop");
    assert.ok(deferred.body.id, "the deferred job needs an id a caller can follow");
  });
});

describe("restart", () => {
  it("resumes delivering its queues after a restart, with their real retry limits", async () => {
    // The bug this guards: rebuilding a spec from our config table alone would
    // default the retry numbers, and a queue configured with retryLimit 5 would
    // report 3 in every log line after the first restart.
    await harness.call("POST", "/v1/queues", {
      name: "test.restart",
      target: receiver.url,
      retryLimit: 5,
    });
    await harness.stop();

    harness = await startHarness(testConfig(databaseUrl));
    const spec = harness.scheduler.spec("test.restart");
    assert.ok(spec, "the queue was forgotten across a restart");
    assert.equal(spec.retryLimit, 5);
    assert.equal(spec.mode, "push");
    assert.equal(spec.target && spec.target.kind === "url" && spec.target.url, receiver.url);

    // And it still delivers.
    const before = receiver.received.length;
    await harness.call("POST", "/v1/jobs", { queue: "test.restart", data: { after: "restart" } });
    await eventually(() => receiver.received.length > before, "delivery after a restart");
  });
});
