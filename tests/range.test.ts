import { describe, expect, test } from "bun:test";

import { parseRangeHeader, resolveRange } from "../src/index";

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

describe("resolveRange", () => {
  const SIZE = 1000;

  // prefix: bytes=N-
  test("prefix open-ended within size → served to end", () => {
    expect(resolveRange({ kind: "prefix", offset: 0 }, SIZE)).toEqual({
      kind: "satisfied",
      start: 0,
      length: SIZE,
    });
    expect(resolveRange({ kind: "prefix", offset: 500 }, SIZE)).toEqual({
      kind: "satisfied",
      start: 500,
      length: 500,
    });
  });

  test("prefix open-ended at size boundary → unsatisfiable", () => {
    expect(resolveRange({ kind: "prefix", offset: SIZE }, SIZE)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveRange({ kind: "prefix", offset: SIZE + 1 }, SIZE)).toEqual({
      kind: "unsatisfiable",
    });
  });

  // prefix: bytes=N-M
  test("prefix with length within size → served as requested", () => {
    expect(resolveRange({ kind: "prefix", offset: 100, length: 200 }, SIZE)).toEqual({
      kind: "satisfied",
      start: 100,
      length: 200,
    });
  });

  test("prefix with length extending past size → clamped to size-1", () => {
    // bytes=900-2000 on a 1000-byte object: serve 900-999 (100 bytes).
    expect(resolveRange({ kind: "prefix", offset: 900, length: 1100 }, SIZE)).toEqual({
      kind: "satisfied",
      start: 900,
      length: 100,
    });
    // bytes=0-99999: serve the whole object.
    expect(resolveRange({ kind: "prefix", offset: 0, length: 99999 }, SIZE)).toEqual({
      kind: "satisfied",
      start: 0,
      length: SIZE,
    });
  });

  test("prefix offset == size with explicit length → unsatisfiable", () => {
    expect(resolveRange({ kind: "prefix", offset: SIZE, length: 1 }, SIZE)).toEqual({
      kind: "unsatisfiable",
    });
  });

  // suffix: bytes=-N
  test("suffix within size → served from tail", () => {
    expect(resolveRange({ kind: "suffix", length: 500 }, SIZE)).toEqual({
      kind: "satisfied",
      start: 500,
      length: 500,
    });
    expect(resolveRange({ kind: "suffix", length: 1 }, SIZE)).toEqual({
      kind: "satisfied",
      start: 999,
      length: 1,
    });
  });

  test("suffix N >= size → serve whole object (RFC 9110 §14.1.2)", () => {
    expect(resolveRange({ kind: "suffix", length: SIZE }, SIZE)).toEqual({
      kind: "satisfied",
      start: 0,
      length: SIZE,
    });
    expect(resolveRange({ kind: "suffix", length: SIZE + 5000 }, SIZE)).toEqual({
      kind: "satisfied",
      start: 0,
      length: SIZE,
    });
  });

  test("suffix N == 0 → unsatisfiable", () => {
    expect(resolveRange({ kind: "suffix", length: 0 }, SIZE)).toEqual({
      kind: "unsatisfiable",
    });
  });

  // empty-object edge: RFC 9110 §14.1.2 — no byte-range-spec is satisfiable
  // when the representation has zero bytes.
  test("empty object → all ranges unsatisfiable", () => {
    expect(resolveRange({ kind: "prefix", offset: 0 }, 0)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveRange({ kind: "suffix", length: 1 }, 0)).toEqual({
      kind: "unsatisfiable",
    });
  });
});
