/**
 * The signature, and the recipe a receiver follows.
 *
 * `sign` and `verify` are tested as a pair on purpose: the documented
 * verification recipe in README.md is `verify`, so if the two ever drift, every
 * receiver on your fleet starts rejecting real deliveries at the same moment.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { sign, verify } from "../../src/delivery.ts";

const KEY = "0123456789abcdef0123456789abcdef";

describe("sign", () => {
  it("is a plain sha256 HMAC over the exact bytes sent", () => {
    const body = '{"hello":"world"}';
    const expected = "sha256=" + createHmac("sha256", KEY).update(body, "utf8").digest("hex");
    assert.equal(sign(body, KEY), expected);
  });

  it("changes when a single byte of the body changes", () => {
    assert.notEqual(sign('{"a":1}', KEY), sign('{"a":2}', KEY));
  });

  it("changes when the key changes", () => {
    assert.notEqual(sign('{"a":1}', KEY), sign('{"a":1}', KEY.replace("0", "f")));
  });

  it("signs unicode by its utf-8 bytes, not by code units", () => {
    // A receiver in another language hashes bytes off the wire. If this hashed
    // UTF-16 code units, every payload with an emoji or an accent would fail
    // verification on a Python receiver and pass in Node.
    const body = '{"msg":"café ☕"}';
    const expected = "sha256=" + createHmac("sha256", KEY).update(Buffer.from(body, "utf8")).digest("hex");
    assert.equal(sign(body, KEY), expected);
  });
});

describe("verify", () => {
  it("accepts what sign produced", () => {
    const body = '{"queue":"ops.morning-ping"}';
    assert.equal(verify(body, KEY, sign(body, KEY)), true);
  });

  it("rejects a tampered body", () => {
    const signature = sign('{"amount":1}', KEY);
    assert.equal(verify('{"amount":1000}', KEY, signature), false);
  });

  it("rejects a signature made with a different key", () => {
    const body = '{"a":1}';
    assert.equal(verify(body, KEY, sign(body, "ffffffffffffffffffffffffffffffff")), false);
  });

  it("rejects an empty or malformed signature rather than throwing", () => {
    // timingSafeEqual throws on a length mismatch, so a receiver passing a
    // truncated header must get `false`, not a 500.
    for (const bad of ["", "sha256=", "nonsense", "sha256=abc"]) {
      assert.equal(verify('{"a":1}', KEY, bad), false);
    }
  });
});
