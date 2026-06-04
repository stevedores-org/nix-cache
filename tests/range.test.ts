import { describe, expect, test } from "bun:test";

import { parseRangeHeader } from "../src/index";

describe("parseRangeHeader", () => {
  test("returns null for null / empty / missing header", () => {
    expect(parseRangeHeader(null)).toBeNull();
    expect(parseRangeHeader("")).toBeNull();
  });

  test("returns null for unrecognised syntax (treat as no Range)", () => {
    expect(parseRangeHeader("bytes=abc")).toBeNull();
    expect(parseRangeHeader("items=0-100")).toBeNull();
    expect(parseRangeHeader("bytes=")).toBeNull();
  });

  test("prefix form bytes=N-M", () => {
    expect(parseRangeHeader("bytes=0-99")).toEqual({
      kind: "prefix",
      offset: 0,
      length: 100,
    });
    expect(parseRangeHeader("bytes=500-1023")).toEqual({
      kind: "prefix",
      offset: 500,
      length: 524,
    });
  });

  test("prefix form bytes=N- (open-ended)", () => {
    expect(parseRangeHeader("bytes=0-")).toEqual({
      kind: "prefix",
      offset: 0,
    });
    expect(parseRangeHeader("bytes=12345-")).toEqual({
      kind: "prefix",
      offset: 12345,
    });
  });

  test("suffix form bytes=-N (last N bytes)", () => {
    expect(parseRangeHeader("bytes=-500")).toEqual({
      kind: "suffix",
      length: 500,
    });
    expect(parseRangeHeader("bytes=-1")).toEqual({
      kind: "suffix",
      length: 1,
    });
  });

  test("inverted range (end < start) is invalid", () => {
    expect(parseRangeHeader("bytes=100-50")).toEqual({ kind: "invalid" });
  });

  test("zero-length suffix is invalid", () => {
    expect(parseRangeHeader("bytes=-0")).toEqual({ kind: "invalid" });
  });

  test("multi-range is invalid (416)", () => {
    expect(parseRangeHeader("bytes=0-100,200-300")).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=0-100, 200-300")).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=0-100,-50")).toEqual({ kind: "invalid" });
    expect(parseRangeHeader("bytes=-100,-50")).toEqual({ kind: "invalid" });
  });

  test("equal start and end is a 1-byte prefix range", () => {
    expect(parseRangeHeader("bytes=42-42")).toEqual({
      kind: "prefix",
      offset: 42,
      length: 1,
    });
  });
});
