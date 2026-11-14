import { beforeEach, describe, expect, it } from "vitest";
import { useControlBadgeStore } from "../controlBadgeStore";

beforeEach(() => useControlBadgeStore.setState({ badges: {} }));

describe("controlBadgeStore", () => {
	it("shows a badge while a call runs and clears it after", () => {
		const end = useControlBadgeStore.getState().begin("b", "p1");
		expect(useControlBadgeStore.getState().badges.b).toEqual({
			by: "p1",
			count: 1,
		});
		end();
		expect(useControlBadgeStore.getState().badges.b).toBeUndefined();
	});

	it("stays until the last of several calls ends, naming the latest caller", () => {
		const s = useControlBadgeStore.getState();
		const end1 = s.begin("b", "p1");
		const end2 = s.begin("b", "rev");
		expect(useControlBadgeStore.getState().badges.b.by).toBe("rev");
		end1();
		end1();
		expect(useControlBadgeStore.getState().badges.b).toEqual({
			by: "rev",
			count: 1,
		});
		end2();
		expect(useControlBadgeStore.getState().badges.b).toBeUndefined();
	});
});
