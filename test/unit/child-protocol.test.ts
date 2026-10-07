import { describe, expect, it } from "vitest";
import {
	assertChildState,
	ChildProtocolError,
	type ChildState,
	decodeChildFrame,
	encodeChildFrame,
	parseChildRequest,
} from "../../extension-src/pi-teams/domain/child-protocol.js";

const validState: ChildState = {
	childId: "child-a",
	pid: process.pid,
	execution: "idle",
	transcript: {
		items: [{ kind: "user", timestamp: 1, text: "hello" }],
		cursor: 1,
		offset: 0,
		truncated: false,
	},
	seq: 0,
};

describe("child protocol framing", () => {
	it("encodes UTF-8 JSON as one newline-delimited frame", () => {
		const frame = encodeChildFrame({ id: "r1", value: "é" });
		expect(frame.at(-1)).toBe(10);
		expect(frame.byteLength).toBe(Buffer.byteLength('{"id":"r1","value":"é"}\n'));
		expect(decodeChildFrame(frame.subarray(0, -1))).toEqual({ id: "r1", value: "é" });
	});

	it("rejects oversized and non-serializable frames and malformed JSON", () => {
		expect(() => encodeChildFrame({ value: "é" }, 10)).toThrowError(ChildProtocolError);
		expect(() => decodeChildFrame(Buffer.from("{"))).toThrowError(ChildProtocolError);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => encodeChildFrame(cyclic)).toThrowError(ChildProtocolError);
	});

	it("accepts only a known RPC method and an object params envelope", () => {
		expect(parseChildRequest({ id: "q1", method: "state", params: {} })).toEqual({
			id: "q1",
			method: "state",
			params: {},
		});
		expect(() => parseChildRequest({ id: "q2", method: "spawn", params: {} })).toThrowError(ChildProtocolError);
		expect(() => parseChildRequest({ id: "q3", method: "state", params: [] })).toThrowError(ChildProtocolError);
	});
});

describe("child state validation", () => {
	it("accepts a bounded transcript snapshot with absolute cursor offsets", () => {
		expect(assertChildState(validState, "child-a")).toEqual(validState);
	});

	it("rejects identity and inconsistent transcript offsets", () => {
		expect(() => assertChildState(validState, "child-b")).toThrowError(ChildProtocolError);
		expect(() =>
			assertChildState({ ...validState, transcript: { ...validState.transcript, offset: 1 } }, "child-a"),
		).toThrowError(ChildProtocolError);
	});
	it("validates focus capabilities and streamed transcript identity", () => {
		const focused: ChildState = {
			...validState,
			transcript: {
				items: [{ kind: "assistant", timestamp: 2, id: "run:1:0", revision: 1, partial: true, text: "par" }],
				cursor: 1,
				offset: 0,
				truncated: false,
			},
			focus: {
				cwd: "/tmp/child",
				thinking: "high",
				capabilities: { models: [], thinking: ["high"], commands: ["model", "thinking"] },
			},
		};
		expect(assertChildState(focused, "child-a")).toEqual(focused);
		expect(() =>
			assertChildState(
				{
					...focused,
					focus: {
						...focused.focus,
						capabilities: { models: [], thinking: ["instant"], commands: ["model"] },
					},
				},
				"child-a",
			),
		).toThrowError(ChildProtocolError);
		expect(() =>
			assertChildState(
				{
					...focused,
					transcript: {
						...focused.transcript,
						items: [{ kind: "assistant", timestamp: 2, partial: true, text: "missing identity" }],
					},
				},
				"child-a",
			),
		).toThrowError(ChildProtocolError);
	});
});
