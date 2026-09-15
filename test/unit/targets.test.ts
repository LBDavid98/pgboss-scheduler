/**
 * Target parsing — where a due job is sent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TargetError, parseTarget } from "../../src/targets.ts";

describe("parseTarget", () => {
  it("accepts a bare URL string as the common case", () => {
    assert.deepEqual(parseTarget("http://ntfy/app-alerts"), {
      kind: "url",
      url: "http://ntfy/app-alerts",
    });
  });

  it("refuses a scheme that is not http", () => {
    // file:// and friends would make the target a local-file read from inside
    // the container rather than a delivery.
    for (const url of ["file:///etc/passwd", "ftp://x/y", "ntfy/topic", ""]) {
      assert.throws(() => parseTarget(url), TargetError, `accepted ${url}`);
    }
  });

  it("refuses a header the delivery itself owns", () => {
    // Dropping it silently would leave a caller believing their delivery is
    // authenticated by a header that never went out.
    assert.throws(
      () => parseTarget({ kind: "url", url: "http://x/y", headers: { Authorization: "Bearer s3cret" } }),
      /may not set Authorization/,
    );
    assert.throws(
      () => parseTarget({ kind: "url", url: "http://x/y", headers: { "X-App-Job-Id": "1" } }),
      /may not set/,
    );
  });

  it("keeps headers a receiver legitimately needs", () => {
    const target = parseTarget({ kind: "url", url: "http://x/y", headers: { "X-Ntfy-Priority": "5" } });
    assert.deepEqual(target, { kind: "url", url: "http://x/y", headers: { "X-Ntfy-Priority": "5" } });
  });

  it("parses an agent target and defaults its capture to full", () => {
    assert.deepEqual(parseTarget({ kind: "agent", agent_id: "agents/qa-draft" }), {
      kind: "agent",
      agent_id: "agents/qa-draft",
      capture: "full",
    });
  });

  it("refuses an agent target with no agent id", () => {
    assert.throws(() => parseTarget({ kind: "agent" }), /needs `agent_id`/);
  });

  it("refuses a capture mode the runner does not have", () => {
    assert.throws(() => parseTarget({ kind: "agent", agent_id: "a", capture: "some" }), /capture must be/);
  });

  it("names an unknown kind rather than falling back to url", () => {
    assert.throws(() => parseTarget({ kind: "grpc", url: "http://x" }), /unknown target kind: grpc/);
  });
});
