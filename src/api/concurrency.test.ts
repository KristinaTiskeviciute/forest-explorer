import { describe, expect, test } from "vitest";
import { mapPool } from "./concurrency";

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapPool", () => {
    test("results are returned in input order regardless of completion timing", async () => {
        const items = [30, 10, 20, 5];
        const results = await mapPool(items, 4, async (ms) => {
            await delay(ms);
            return ms;
        });
        expect(results).toEqual(items);
    });

    test("never runs more than `limit` items concurrently", async () => {
        let active = 0;
        let maxActive = 0;
        const items = Array.from({ length: 10 }, (_, i) => i);

        await mapPool(items, 3, async (i) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await delay(5);
            active--;
            return i;
        });

        expect(maxActive).toBeLessThanOrEqual(3);
        expect(maxActive).toBeGreaterThan(1); // actually ran concurrently, not serialized
    });

    test("limit higher than the item count is clamped to the item count without erroring", async () => {
        const results = await mapPool([1, 2], 10, async (n) => n * 2);
        expect(results).toEqual([2, 4]);
    });

    test("an empty item list resolves to an empty array", async () => {
        const results = await mapPool([], 5, async (n) => n);
        expect(results).toEqual([]);
    });

    test("a rejection from any item propagates and rejects the whole pool", async () => {
        const items = [1, 2, 3, 4, 5];
        await expect(
            mapPool(items, 2, async (n) => {
                if (n === 3) throw new Error("item 3 failed");
                await delay(1);
                return n;
            }),
        ).rejects.toThrow("item 3 failed");
    });
});
