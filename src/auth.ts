/**
 * Bearer tokens, mapped to caller names.
 *
 * The point of naming callers rather than having one shared token: a job records
 * WHO scheduled it. "Something scheduled this" is not an answer anyone can act
 * on six weeks later, and it is the question that gets asked first when a job
 * starts misbehaving.
 *
 * Comparison is constant-time. The window is small — this service is on a private
 * network — but a timing-safe compare is three lines and the alternative is a
 * paragraph in a review explaining why it does not matter here.
 */

import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";

/** The caller's name, or null. Never throws, never logs the presented token. */
export function callerFor(config: Config, header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const presented = Buffer.from(match[1]);

  for (const [token, name] of config.tokens) {
    const known = Buffer.from(token);
    // Length is not a secret worth protecting here, and timingSafeEqual throws
    // on a length mismatch, so it has to be checked first either way.
    if (known.length === presented.length && timingSafeEqual(known, presented)) {
      return name;
    }
  }
  return null;
}
