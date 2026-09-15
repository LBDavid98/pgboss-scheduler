/**
 * Bearer tokens to caller names.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callerFor } from "../../src/auth.ts";
import { loadConfig } from "../../src/config.ts";

const env = {
  DATABASE_URL: "postgres://u:p@postgres:5432/scheduler",
  SCHEDULER_TOKENS: "ops:tok-ops-aaaa,app-two:tok-cc-bbbb",
  SCHEDULER_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
};
const config = loadConfig(env as NodeJS.ProcessEnv);

describe("callerFor", () => {
  it("names the caller behind a known token", () => {
    assert.equal(callerFor(config, "Bearer tok-ops-aaaa"), "ops");
    assert.equal(callerFor(config, "Bearer tok-cc-bbbb"), "app-two");
  });

  it("accepts the scheme case-insensitively, as clients vary", () => {
    assert.equal(callerFor(config, "bearer tok-ops-aaaa"), "ops");
  });

  it("returns null rather than throwing on anything unusable", () => {
    for (const header of [undefined, "", "tok-ops-aaaa", "Basic abc", "Bearer ", "Bearer wrong"]) {
      assert.equal(callerFor(config, header), null, `accepted ${String(header)}`);
    }
  });

  it("does not accept a token that is merely a prefix of a real one", () => {
    assert.equal(callerFor(config, "Bearer tok-ops"), null);
  });
});

describe("loadConfig", () => {
  it("refuses to boot without a signing key rather than failing on first job", () => {
    assert.throws(
      () => loadConfig({ ...env, SCHEDULER_SIGNING_KEY: undefined } as NodeJS.ProcessEnv),
      /SCHEDULER_SIGNING_KEY is not set/,
    );
  });

  it("refuses a signing key short enough to make the HMAC decoration", () => {
    assert.throws(
      () => loadConfig({ ...env, SCHEDULER_SIGNING_KEY: "short" } as NodeJS.ProcessEnv),
      /shorter than 32/,
    );
  });

  it("refuses malformed token pairs without echoing the value", () => {
    try {
      loadConfig({ ...env, SCHEDULER_TOKENS: "no-colon-here" } as NodeJS.ProcessEnv);
      assert.fail("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /name:token pairs/);
      // The bad value must not appear in an error that ends up in a log.
      assert.equal(message.includes("no-colon-here"), false);
    }
  });

  it("points agent targets at the mesh studio, not the 503 tombstone on 8011", () => {
    assert.equal(config.agentRunnerUrl, "http://agent-runner:8010");
  });
});
