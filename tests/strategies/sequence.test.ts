import { describe, expect, it } from "vitest";
import { minimizeSequence, shrink } from "../../src/index.js";

describe("minimizeSequence", () => {
  it("reduces an event sequence to the steps that matter", async () => {
    const events = [
      { type: "click", target: "#a" },
      { type: "type", text: "hello" },
      { type: "click", target: "#submit" },
      { type: "wait", ms: 100 },
      { type: "click", target: "#b" },
    ];

    const result = await minimizeSequence(events, {
      test: (candidate) => candidate.some((event) => event.target === "#submit"),
    });

    expect(result.items).toEqual([{ type: "click", target: "#submit" }]);
    expect(result.oneMinimal).toBe(true);
    expect(result.tests).toBeGreaterThan(0);
  });

  it("keeps order-dependent sequences intact", async () => {
    const steps = ["open", "login", "add-to-cart", "checkout", "logout"];
    const result = await minimizeSequence(steps, {
      test: (candidate) => {
        const loginIndex = candidate.indexOf("login");
        const checkoutIndex = candidate.indexOf("checkout");
        return loginIndex >= 0 && checkoutIndex > loginIndex;
      },
    });
    expect(result.items).toEqual(["login", "checkout"]);
  });

  it("simplifies individual items when a simplifier is provided", async () => {
    const result = await minimizeSequence(
      [
        { id: 1, payload: "aaaa" },
        { id: 2, payload: "bbbb" },
      ],
      {
        test: (candidate) => candidate.some((item) => item.id === 2),
        simplifyItem: function* (item) {
          if (item.payload.length > 0) yield { ...item, payload: "" };
        },
      },
    );

    expect(result.items).toEqual([{ id: 2, payload: "" }]);
  });

  it("stops at maxTests", async () => {
    const result = await minimizeSequence(
      Array.from({ length: 100 }, (_, index) => index),
      {
        test: () => false,
        maxTests: 5,
      },
    );
    expect(result.tests).toBeLessThanOrEqual(5);
    expect(result.items.length).toBe(100);
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    const result = await minimizeSequence(
      Array.from({ length: 100 }, (_, index) => index),
      {
        test: () => {
          controller.abort();
          return false;
        },
        signal: controller.signal,
      },
    );
    expect(result.tests).toBeLessThanOrEqual(2);
  });

  it("works with an async predicate", async () => {
    const result = await minimizeSequence([1, 2, 3, 4], {
      test: async (candidate) => {
        await Promise.resolve();
        return candidate.includes(3);
      },
    });
    expect(result.items).toEqual([3]);
  });
});

describe("sequence reduction through shrink()", () => {
  it("reduces arrays of request records", async () => {
    const requests = Array.from({ length: 50 }, (_, index) => ({
      method: index % 2 === 0 ? "GET" : "POST",
      path: `/api/items/${index}`,
      headers: { "content-type": "application/json", "x-trace": String(index) },
    }));

    const result = await shrink({
      input: requests,
      test: (candidate) =>
        candidate.some((request) => request.path === "/api/items/37" && request.method === "POST"),
    });

    expect(result.minimalInput).toEqual([{ method: "POST", path: "/api/items/37" }]);
  });
});
