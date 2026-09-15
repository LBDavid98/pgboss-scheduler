/**
 * Queue spec validation.
 *
 * These are the rules that stop a queue being saved in a state that looks
 * configured and delivers nothing — the failure mode that is expensive because
 * it is silent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueueError, bossQueueOptions, parseQueueSpec } from "../../src/queues.ts";

const push = { name: "ops.morning-ping", target: "http://ntfy/app-alerts" };

describe("parseQueueSpec", () => {
  it("defaults to push, an envelope body, and a dead-letter queue", () => {
    const spec = parseQueueSpec({ ...push }, "ops");
    assert.equal(spec.mode, "push");
    assert.equal(spec.payload, "envelope");
    // The default that matters: an exhausted job lands somewhere inspectable
    // instead of being marked failed and aged out by retention.
    assert.equal(spec.deadLetter, "ops.morning-ping.dlq");
  });

  it("records the owner from the token, not from the body", () => {
    const spec = parseQueueSpec({ ...push, owner: "someone-else" }, "ops");
    assert.equal(spec.owner, "ops");
  });

  it("refuses a push queue with no target", () => {
    assert.throws(() => parseQueueSpec({ name: "a.b" }, "ops"), QueueError);
  });

  it("refuses a pull queue that was given a target", () => {
    // Refused rather than ignored: a target on a pull queue is a
    // misunderstanding that would otherwise sit in the config looking correct.
    assert.throws(
      () => parseQueueSpec({ name: "a.b", mode: "pull", target: "http://x/y" }, "ops"),
      /pull queue has no target/,
    );
  });

  it("refuses a name that ends in the reserved dead-letter suffix", () => {
    assert.throws(() => parseQueueSpec({ ...push, name: "a.b.dlq" }, "ops"), /reserved/);
  });

  it("refuses names that would not survive being a table partition or a URL", () => {
    for (const name of ["", "A.B", "has space", "a", "trailing-", "sla/sh"]) {
      assert.throws(() => parseQueueSpec({ ...push, name }, "ops"), QueueError, `accepted ${name}`);
    }
  });

  it("accepts a dotted namespace, which is the intended convention", () => {
    assert.equal(parseQueueSpec({ ...push, name: "cc.agent-maintenance" }, "ops").name, "cc.agent-maintenance");
  });

  it("lets a caller turn the dead-letter queue off explicitly", () => {
    assert.equal(parseQueueSpec({ ...push, deadLetter: null }, "ops").deadLetter, null);
  });

  it("refuses out-of-range numbers instead of clamping them", () => {
    // Clamping would mean a caller asking for a 30-day expiry gets 1 day and is
    // never told, then wonders why long jobs are being killed.
    assert.throws(() => parseQueueSpec({ ...push, retryLimit: -1 }, "ops"), /retryLimit/);
    assert.throws(() => parseQueueSpec({ ...push, expireInSeconds: 0 }, "ops"), /expireInSeconds/);
    assert.throws(() => parseQueueSpec({ ...push, concurrency: 999 }, "ops"), /concurrency/);
  });

  it("defaults retries to something a down receiver can survive", () => {
    const spec = parseQueueSpec({ ...push }, "ops");
    assert.equal(spec.retryLimit, 3);
    assert.equal(spec.retryDelay, 60);
    assert.equal(spec.retryBackoff, true);
  });

  it("accepts payload: data for a receiver with its own body format", () => {
    // ntfy is the motivating case — it will not learn our envelope shape.
    assert.equal(parseQueueSpec({ ...push, payload: "data" }, "ops").payload, "data");
    assert.throws(() => parseQueueSpec({ ...push, payload: "xml" }, "ops"), /payload must be/);
  });
});

describe("bossQueueOptions", () => {
  it("passes through only what pg-boss understands", () => {
    const options = bossQueueOptions(parseQueueSpec({ ...push }, "ops"));
    assert.deepEqual(Object.keys(options).sort(), [
      "deadLetter", "expireInSeconds", "policy", "retentionSeconds",
      "retryBackoff", "retryDelay", "retryLimit",
    ]);
    // mode, target and payload are OURS. Handing them to pg-boss would be a
    // silent no-op today and a name collision the day pg-boss adds one.
    assert.equal("target" in options, false);
    assert.equal("mode" in options, false);
  });
});
