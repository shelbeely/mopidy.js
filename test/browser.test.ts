import { describe, expect, test } from "bun:test";

describe("browser entry point", () => {
  test("assigns Mopidy to globalThis", async () => {
    // Import the browser entry point. Since imports are cached, use a
    // dynamic import so this test can be isolated if needed.
    const { default: Mopidy } = await import("../src/browser");

    expect((globalThis as { Mopidy?: typeof Mopidy }).Mopidy).toBe(Mopidy);
  });

  test("globalThis.Mopidy is the Mopidy constructor", async () => {
    const { default: Mopidy } = await import("../src/browser");
    const g = globalThis as { Mopidy?: typeof Mopidy };

    expect(typeof g.Mopidy).toBe("function");
    expect(g.Mopidy).toBe(Mopidy);
  });
});
