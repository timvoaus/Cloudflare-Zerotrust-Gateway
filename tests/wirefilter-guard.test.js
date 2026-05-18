import { describe, it } from "node:test";
import assert from "node:assert";
import {
  warnIfWirefilterExpressionLarge,
  WIREFILTER_WARN_LIST_COUNT,
  WIREFILTER_WARN_EXPRESSION_LENGTH,
} from "../lib/wirefilter-guard.js";

describe("wirefilter-guard", () => {
  it("should warn when list count exceeds threshold", () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (msg) => warnings.push(msg);

    try {
      warnIfWirefilterExpressionLarge("expr", { listCount: WIREFILTER_WARN_LIST_COUNT });
      assert.ok(warnings.some((w) => w.includes("lists")));
    } finally {
      console.warn = original;
    }
  });

  it("should warn when expression length exceeds threshold", () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (msg) => warnings.push(msg);

    try {
      const longExpr = "x".repeat(WIREFILTER_WARN_EXPRESSION_LENGTH);
      warnIfWirefilterExpressionLarge(longExpr, { listCount: 1 });
      assert.ok(warnings.some((w) => w.includes("characters")));
    } finally {
      console.warn = original;
    }
  });

  it("should not warn for small expressions", () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (msg) => warnings.push(msg);

    try {
      warnIfWirefilterExpressionLarge("any(dns.domains[*] in $abc)", { listCount: 5 });
      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = original;
    }
  });
});
