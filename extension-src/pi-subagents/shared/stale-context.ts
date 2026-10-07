// Stale-extension-context detection, ported from the pi-task reference
// (src/stale-ctx.ts). When a Pi session is replaced (/new, /resume, reload),
// a captured context can still be referenced by in-flight async work; the
// host rejects it with one of the error strings below. Delivery code treats
// those as an expected refusal (the delivery guard refuses stale contexts
// anyway) and swallows them instead of crashing run settlement.

const STALE_EXTENSION_CTX_RE =
	/(?:this extension ctx is stale|captured pi or command ctx|stale after session replacement|stale after session reload|ctx is stale after)/i;

/** True when the error looks like a rejected, session-replaced extension ctx. */
export function isStaleExtensionCtxError(error: unknown): boolean {
	if (typeof error === "string") return STALE_EXTENSION_CTX_RE.test(error);
	if (error instanceof Error) return STALE_EXTENSION_CTX_RE.test(error.message);
	if (!error || typeof error !== "object") return false;
	const record = error as Record<string, unknown>;
	for (const value of [record.message, record.error, record.reason]) {
		if (typeof value === "string" && STALE_EXTENSION_CTX_RE.test(value)) {
			return true;
		}
	}
	return false;
}

/**
 * Run `fn`, swallowing only stale-context rejections; every other error
 * propagates so real failures stay visible.
 */
export function ignoreStaleExtensionCtx(fn: () => void): void {
	try {
		fn();
	} catch (error) {
		if (!isStaleExtensionCtxError(error)) throw error;
	}
}
