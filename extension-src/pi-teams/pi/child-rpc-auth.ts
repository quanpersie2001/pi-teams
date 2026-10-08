import { createHmac } from "node:crypto";

/** A presentation credential cannot authenticate as the native execution owner. */
export function deriveViewerToken(childId: string, ownerToken: string): string {
	return createHmac("sha256", ownerToken).update("pi-teams-viewer\0").update(childId).digest("hex");
}
