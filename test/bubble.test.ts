import { expect, test } from "vitest";
import { bubbleSide } from "../src/bubble.ts";

test("bubbleSide puts the bubble below when it fits there", () => {
  expect(bubbleSide(100, 200, 80, 600)).toBe("below");
});

test("bubbleSide puts the bubble above when it fits only there", () => {
  expect(bubbleSide(400, 500, 150, 600)).toBe("above");
});

test("bubbleSide falls back to below when it fits on neither side", () => {
  expect(bubbleSide(100, 500, 200, 600)).toBe("below");
});
