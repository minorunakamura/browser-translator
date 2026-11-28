import { expect, test } from "vitest";
import { READER_SIZES_PX, stepValue, validLook } from "../src/reader.ts";

test("stepValue moves one step and stays at the ends", () => {
  expect(stepValue(READER_SIZES_PX, 18, 1)).toBe(20);
  expect(stepValue(READER_SIZES_PX, 18, -1)).toBe(16);
  expect(stepValue(READER_SIZES_PX, 28, 1)).toBe(28);
  expect(stepValue(READER_SIZES_PX, 14, -1)).toBe(14);
});

test("validLook defaults to black, gothic, 18px and 40em", () => {
  expect(validLook(undefined)).toEqual({
    theme: "black",
    font: "gothic",
    sizePx: 18,
    widthEm: 40,
  });
});

test("validLook replaces values that are not one of the choices", () => {
  expect(
    validLook({ theme: "sepia", font: "mincho", sizePx: 17, widthEm: 60 }),
  ).toEqual({ theme: "sepia", font: "mincho", sizePx: 18, widthEm: 60 });
});
