import { describe, expect, it, vi } from "vitest";
import { commitWrite } from "../../src/data/write";

describe("commitWrite", () => {
  it("resolves 'acked' when the server acknowledges in time", async () => {
    await expect(commitWrite(Promise.resolve(), { online: true, timeoutMs: 1000 })).resolves.toBe("acked");
  });

  it("propagates errors that arrive in time (e.g. permission denied)", async () => {
    await expect(commitWrite(Promise.reject(new Error("denied")), { online: true })).rejects.toThrow("denied");
  });

  it("returns 'pending' immediately when offline and logs a late failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reject!: (e: Error) => void;
    const write = new Promise<void>((_, r) => (reject = r));
    await expect(commitWrite(write, { online: false })).resolves.toBe("pending");
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns 'pending' when the ack does not arrive before the timeout", async () => {
    const never = new Promise<void>(() => {});
    await expect(commitWrite(never, { online: true, timeoutMs: 5 })).resolves.toBe("pending");
  });
});
