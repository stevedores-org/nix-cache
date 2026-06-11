import { describe, expect, test } from "bun:test";

import { parseNarinfoFields } from "../src/index";

describe("parseNarinfoFields", () => {
  test("accepts single-valued fields and multiple Sig lines", () => {
    const text = [
      "StorePath: /nix/store/abc",
      "NarHash: sha256:deadbeef",
      "NarSize: 42",
      "References:",
      "Sig: key-1:abc",
      "Sig: key-2:def",
    ].join("\n");
    const parsed = parseNarinfoFields(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fields.StorePath).toBe("/nix/store/abc");
    expect(parsed.sigs).toEqual(["key-1:abc", "key-2:def"]);
  });

  test("rejects duplicate non-Sig fields", () => {
    const text = [
      "StorePath: /nix/store/legit",
      "StorePath: /nix/store/evil",
      "NarHash: sha256:abc",
      "NarSize: 1",
      "References:",
    ].join("\n");
    expect(parseNarinfoFields(text)).toEqual({ ok: false });
  });
});
