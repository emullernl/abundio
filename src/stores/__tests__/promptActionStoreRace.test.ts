/**
 * The read-modify-write race that ADR-0039 avoids at list level, one level
 * down: two edits to *different fields of the same row*, sent while the first
 * is still in flight.
 *
 * Settings builds each write from `actions`, so if the store left that stale
 * for the length of the round-trip, blurring two parameter fields in quick
 * succession — an ordinary Tab — read the pre-first-edit params and sent them
 * back, silently undoing the first edit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();

vi.mock("../../lib/ipc", () => ({
	promptActions: {
		list: vi.fn().mockResolvedValue([]),
		create: vi.fn(),
		update: (...args: unknown[]) => update(...args),
		delete: vi.fn(),
		reorder: vi.fn(),
		onChanged: vi.fn().mockResolvedValue(() => {}),
	},
}));

import type { PromptActionRow } from "../../lib/types";
import { usePromptActionStore } from "../promptActionStore";

function row(over: Partial<PromptActionRow> = {}): PromptActionRow {
	return {
		id: "a1",
		name: "Review",
		body: "{{a}} {{b}}",
		scopeKind: "all",
		scopeAgentIds: [],
		paramsJson: "{}",
		showInBar: true,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

describe("promptActionStore — in-flight writes", () => {
	beforeEach(() => {
		update.mockReset();
		usePromptActionStore.setState({
			actions: [
				{
					id: "a1",
					name: "Review",
					body: "{{a}} {{b}}",
					scope: { kind: "all" },
					params: {},
					showInBar: true,
					position: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			],
			loaded: true,
			error: null,
		});
	});

	it("reflects an update as soon as it resolves, without a re-read", async () => {
		update.mockResolvedValue(
			row({ paramsJson: JSON.stringify({ a: { type: "text" } }) }),
		);
		await usePromptActionStore
			.getState()
			.updateAction("a1", { params: { a: { type: "text" } } });

		expect(usePromptActionStore.getState().actions[0].params).toEqual({
			a: { type: "text" },
		});
	});

	it("does not lose the first edit when a second follows it", async () => {
		// Blur param `a`, then blur param `b` — each write carries the whole
		// params object built from the store, so the second must see the first.
		update.mockResolvedValueOnce(
			row({ paramsJson: JSON.stringify({ a: { type: "number" } }) }),
		);
		await usePromptActionStore
			.getState()
			.updateAction("a1", { params: { a: { type: "number" } } });

		const afterFirst = usePromptActionStore.getState().actions[0].params;
		expect(afterFirst).toEqual({ a: { type: "number" } });

		// What Settings would now build for the second field.
		const merged = { ...afterFirst, b: { type: "toggle" as const } };
		update.mockResolvedValueOnce(row({ paramsJson: JSON.stringify(merged) }));
		await usePromptActionStore
			.getState()
			.updateAction("a1", { params: merged });

		// The first edit survives.
		expect(usePromptActionStore.getState().actions[0].params).toEqual({
			a: { type: "number" },
			b: { type: "toggle" },
		});
	});

	it("leaves other rows untouched", async () => {
		usePromptActionStore.setState({
			actions: [
				...usePromptActionStore.getState().actions,
				{
					id: "a2",
					name: "Other",
					body: "x",
					scope: { kind: "all" },
					params: {},
					showInBar: true,
					position: 1,
					createdAt: 0,
					updatedAt: 0,
				},
			],
		});
		update.mockResolvedValue(row({ name: "Renamed" }));
		await usePromptActionStore.getState().updateAction("a1", {
			name: "Renamed",
		});

		const actions = usePromptActionStore.getState().actions;
		expect(actions.map((a) => a.name)).toEqual(["Renamed", "Other"]);
	});
});
