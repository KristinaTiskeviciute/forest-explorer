import { describe, expect, test } from "vitest";
import { threddsGate } from "./threddsGate";

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

// threddsGate's active-count/queue are module-level singletons (shared
// across every caller — that's the whole point, see the comment in
// threddsGate.ts). Each test below fully drains every task it starts before
// finishing, so the module returns to its clean (active: 0, empty queue)
// state and later tests aren't affected by earlier ones.
describe("threddsGate", () => {
    test("caps concurrent executions at 2 and queues the rest", async () => {
        const starts: number[] = [];
        const d1 = deferred<void>();
        const d2 = deferred<void>();
        const d3 = deferred<void>();

        const p1 = threddsGate(async () => {
            starts.push(1);
            await d1.promise;
        });
        const p2 = threddsGate(async () => {
            starts.push(2);
            await d2.promise;
        });
        const p3 = threddsGate(async () => {
            starts.push(3);
            await d3.promise;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(starts).toEqual([1, 2]); // 3rd is queued, not yet running

        d1.resolve();
        await p1;
        await Promise.resolve();
        expect(starts).toEqual([1, 2, 3]); // releasing a slot lets the 3rd start

        d2.resolve();
        d3.resolve();
        await Promise.all([p2, p3]);
    });

    test("a rejected task still releases its slot for the next queued task", async () => {
        const starts: number[] = [];
        const d2 = deferred<void>();

        const p1 = threddsGate(async () => {
            starts.push(1);
            throw new Error("boom");
        });
        const p2 = threddsGate(async () => {
            starts.push(2);
            await d2.promise;
        });
        const p3 = threddsGate(async () => {
            starts.push(3);
        });

        await expect(p1).rejects.toThrow("boom");
        await Promise.resolve();
        expect(starts).toContain(3); // ran despite the 1st task's rejection

        d2.resolve();
        await Promise.all([p2, p3]);
    });

    test("resolves with the wrapped function's own return value", async () => {
        const result = await threddsGate(async () => 42);
        expect(result).toBe(42);
    });
});
