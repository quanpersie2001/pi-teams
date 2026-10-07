import { describe, expect, it } from "vitest";
import {
	CHILD_SESSION_ENV_VAR,
	isChildSessionContext,
	shouldSkipExtensionInChildSession,
} from "../../extension-src/pi-teams/pi/child-guard.js";

function freshEnv(): Record<string, string | undefined> {
	return {};
}

describe("child-session guard", () => {
	it("is not a child context by default", () => {
		expect(isChildSessionContext(freshEnv())).toBe(false);
		expect(shouldSkipExtensionInChildSession(freshEnv())).toBe(false);
	});

	it("detects the marker env var in accepted truthy spellings", () => {
		for (const value of ["1", "true", "yes", "on", "TRUE", "Yes"]) {
			const env = freshEnv();
			env[CHILD_SESSION_ENV_VAR] = value;
			expect(isChildSessionContext(env)).toBe(true);
		}
	});

	it("ignores falsy or unrecognized marker values", () => {
		for (const value of ["0", "false", "no", "", "off"]) {
			const env = freshEnv();
			env[CHILD_SESSION_ENV_VAR] = value;
			expect(isChildSessionContext(env)).toBe(false);
		}
	});

	it("does not read the real process.env unless asked", () => {
		const previous = process.env[CHILD_SESSION_ENV_VAR];
		try {
			delete process.env[CHILD_SESSION_ENV_VAR];
			expect(isChildSessionContext()).toBe(false);
			const scoped: Record<string, string | undefined> = {};
			scoped[CHILD_SESSION_ENV_VAR] = "1";
			// Marking a scoped env must not leak into the process environment.
			expect(process.env[CHILD_SESSION_ENV_VAR]).toBeUndefined();
			expect(isChildSessionContext(scoped)).toBe(true);
		} finally {
			if (previous !== undefined) process.env[CHILD_SESSION_ENV_VAR] = previous;
		}
	});
});
