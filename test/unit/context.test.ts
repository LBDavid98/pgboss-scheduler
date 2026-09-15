/**
 * The context envelope.
 *
 * The rule being protected: a caller's data comes back exactly as it went in,
 * and `enqueued_by` cannot be forged from the request body.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENVELOPE_KEY, buildEnvelope, pack, unpack } from "../../src/context.ts";

describe("buildEnvelope", () => {
  it("mints a trace id when the caller does not supply one", () => {
    const envelope = buildEnvelope(undefined, "ops");
    assert.match(envelope.context.trace_id, /^[0-9a-f-]{36}$/);
  });

  it("keeps a trace id the caller supplied, so a chain stays one trace", () => {
    const envelope = buildEnvelope({ trace_id: "trace-from-upstream" }, "ops");
    assert.equal(envelope.context.trace_id, "trace-from-upstream");
  });

  it("defaults the actor to the calling service, but lets it name a person", () => {
    assert.equal(buildEnvelope(undefined, "app-two").context.actor, "app-two");
    assert.equal(buildEnvelope({ actor: "ops" }, "app-two").context.actor, "ops");
  });

  it("records who enqueued it from the token, never from the body", () => {
    // The body is caller-controlled. If enqueued_by could be set from it, job
    // history could be made to blame another service.
    const envelope = buildEnvelope(
      { actor: "someone-else", project: "p" } as never,
      "app-three",
    );
    assert.equal(envelope.enqueued_by, "app-three");
  });

  it("omits project and cause rather than storing empty strings", () => {
    const envelope = buildEnvelope(undefined, "ops");
    assert.equal("project" in envelope.context, false);
    assert.equal("cause" in envelope.context, false);
  });
});

describe("pack and unpack", () => {
  it("returns the caller's data byte for byte", () => {
    const data = { topic: "app-alerts", nested: { a: [1, 2, 3] }, n: null };
    const packed = pack(data, buildEnvelope(undefined, "ops"));
    assert.deepEqual(unpack(packed).data, data);
  });

  it("stores the envelope beside the data, not merged into it", () => {
    // A caller with their own `project` field must not lose it to ours.
    const packed = pack({ project: "the caller's own field" }, buildEnvelope({ project: "ours" }, "ops"));
    assert.equal(unpack(packed).data.project, "the caller's own field");
    assert.equal(unpack(packed).envelope?.context.project, "ours");
  });

  it("survives a job stored with no envelope at all", () => {
    // Jobs enqueued before this service existed, or by hand in psql.
    assert.deepEqual(unpack({ a: 1 }), { data: { a: 1 }, envelope: null });
    assert.deepEqual(unpack(null), { data: {}, envelope: null });
  });

  it("uses a reserved key unlikely to collide with a caller's field", () => {
    assert.equal(ENVELOPE_KEY, "__envelope__");
  });
});
