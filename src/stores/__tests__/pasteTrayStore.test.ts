import { beforeEach, describe, expect, it } from "vitest";
import { PASTE_TRAY_MAX, usePasteTrayStore } from "../pasteTrayStore";

const img = (n: number) => ({
	thumb: `t${n}`,
	full: `f${n}`,
	width: n,
	height: n,
});

describe("pasteTrayStore", () => {
	beforeEach(() => usePasteTrayStore.setState({ trays: {} }));

	it("keeps at most PASTE_TRAY_MAX images, dropping the oldest", () => {
		const { add } = usePasteTrayStore.getState();
		for (let n = 1; n <= PASTE_TRAY_MAX + 2; n++) add("p1", img(n));
		const tray = usePasteTrayStore.getState().trays.p1;
		expect(tray).toHaveLength(PASTE_TRAY_MAX);
		expect(tray[0].thumb).toBe("t3");
	});

	it("removes one image, and the tray with its last one", () => {
		const s = usePasteTrayStore.getState();
		s.add("p1", img(1));
		s.add("p1", img(2));
		const [first, second] = usePasteTrayStore.getState().trays.p1;
		s.remove("p1", first.id);
		expect(usePasteTrayStore.getState().trays.p1).toEqual([second]);
		s.remove("p1", second.id);
		expect(usePasteTrayStore.getState().trays.p1).toBeUndefined();
	});

	it("keeps trays per PTY", () => {
		const s = usePasteTrayStore.getState();
		s.add("p1", img(1));
		s.add("p2", img(2));
		s.clear("p1");
		expect(Object.keys(usePasteTrayStore.getState().trays)).toEqual(["p2"]);
	});
});
