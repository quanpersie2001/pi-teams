// Guards the registered tool catalog: the exact names each registrar publishes
// and the collision rule (skip a name pi.getAllTools() already reports).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import type { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import { LIST_MODELS_TOOL_NAME, registerModelTools } from "../../extension-src/pi-teams/pi/model-tools.js";
import { createTeamTaskTools, TEAM_TASK_TOOL_NAMES } from "../../extension-src/pi-teams/pi/team-task-tools.js";
import { registerSubagentTools } from "../../extension-src/pi-teams/pi/tools.js";

interface FakePi {
	pi: ExtensionAPI;
	registered: string[];
}

/** Minimal ExtensionAPI double: records registerTool and reports `claimed` from getAllTools. */
function fakePi(claimed: string[] = []): FakePi {
	const registered: string[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => {
			registered.push(tool.name);
		},
		getAllTools: () => claimed.map((name) => ({ name })),
	};
	return { pi: pi as unknown as ExtensionAPI, registered };
}

const MANAGER = {} as unknown as AgentManager;
const REGISTRY = {} as unknown as AgentRegistry;

describe("team task tool catalog", () => {
	it("keeps child task tools to canonical unified CRUD names", () => {
		expect(TEAM_TASK_TOOL_NAMES).toEqual(["tasks_create", "tasks_list", "tasks_get", "tasks_update", "tasks_cancel"]);
	});

	it("builds exactly the child-safe unified task tools in constant order", () => {
		const tools = createTeamTaskTools(() => undefined);
		expect(tools.map((tool) => tool.name)).toEqual([...TEAM_TASK_TOOL_NAMES]);
	});
});

describe("subagent tool registration", () => {
	it("registers orchestration and lead-only teammate lifecycle tools", () => {
		const { pi, registered } = fakePi();
		const registrations = registerSubagentTools(pi, MANAGER, REGISTRY);
		expect(registrations).toEqual([
			{ name: "Agent" },
			{ name: "get_subagent_result" },
			{ name: "steer_subagent" },
			{ name: "teammate_status" },
			{ name: "teammate_release" },
			{ name: "teammate_retire" },
		]);
		expect(registered).toEqual([
			"Agent",
			"get_subagent_result",
			"steer_subagent",
			"teammate_status",
			"teammate_release",
			"teammate_retire",
		]);
	});

	it("skips names already returned by pi.getAllTools()", () => {
		const { pi, registered } = fakePi(["get_subagent_result", "Agent"]);
		const registrations = registerSubagentTools(pi, MANAGER, REGISTRY);
		expect(registrations).toEqual([
			{ name: "Agent", skipped: true },
			{ name: "get_subagent_result", skipped: true },
			{ name: "steer_subagent" },
			{ name: "teammate_status" },
			{ name: "teammate_release" },
			{ name: "teammate_retire" },
		]);
		expect(registered).toEqual(["steer_subagent", "teammate_status", "teammate_release", "teammate_retire"]);
	});
});

describe("model tool registration", () => {
	it("registers list_models", () => {
		const { pi, registered } = fakePi();
		expect(registerModelTools(pi)).toEqual([{ name: LIST_MODELS_TOOL_NAME }]);
		expect(registered).toEqual([LIST_MODELS_TOOL_NAME]);
	});

	it("skips list_models when the name is already claimed", () => {
		const { pi, registered } = fakePi([LIST_MODELS_TOOL_NAME]);
		expect(registerModelTools(pi)).toEqual([{ name: LIST_MODELS_TOOL_NAME, skipped: true }]);
		expect(registered).toEqual([]);
	});
});
