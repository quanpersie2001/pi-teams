import type { TeammateStatus } from "../app/agent-manager.js";

/** Only idle/busy, available roster identities can be messaged or offered in the composer. */
export function isTeammateMessageAvailable(status: TeammateStatus | undefined): boolean {
	return (
		status !== undefined && (status.state === "idle" || status.state === "busy") && status.availability === "available"
	);
}

/** Project the live roster through current runtime availability without polling. */
export function eligibleTeammateNames(
	members: readonly { name: string }[],
	getStatus: (name: string) => TeammateStatus | undefined,
): string[] {
	return members.flatMap((member) => (isTeammateMessageAvailable(getStatus(member.name)) ? [member.name] : []));
}
