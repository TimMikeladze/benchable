import type { z } from "zod";
import { describe, expect, test } from "bun:test";

import type { runPayloadSchema } from "../src/schema";
import type { RunInput } from "../src/index";

/**
 * `src/index.ts` is self-contained on purpose — it imports nothing, so it can be vendored
 * alone. That means its `RunInput` type can silently drift from what the
 * server accepts on the wire. This file is the tripwire: if the shapes stop matching,
 * `tsc --noEmit` fails here rather than a consumer finding out at runtime with a 400.
 *
 * Compared against `z.input<>` (the pre-coercion wire shape — plain JSON over HTTP, never a
 * `Date` object), not `z.infer<>` (the server's post-parse output type).
 */
type WirePayload = z.input<typeof runPayloadSchema>;

type AssertAssignableToPayload<T extends WirePayload> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _RunInputMatchesPayload = AssertAssignableToPayload<Omit<RunInput, "idempotencyKey">>;

describe("sdk RunInput stays in sync with the server's RunPayload", () => {
  test("this file only asserts at the type level — a passing typecheck is the test", () => {
    expect(true).toBe(true);
  });
});
