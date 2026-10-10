import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelAdmission, ModelAdmissionInput } from "../domain/backend.js";
import { loadChildBootstrap } from "./child-bridge.js";

type NativeModel = Model<Api>;
type ModelResolution = { model: NativeModel } | { reason: string };

function canonicalModel(model: NativeModel): string {
	return `${model.provider}/${model.id}`;
}

function resolveModel(reference: string, models: readonly NativeModel[]): ModelResolution {
	const target = reference.toLowerCase();
	const canonical = models.find((model) => canonicalModel(model).toLowerCase() === target);
	if (canonical) return { model: canonical };

	const separator = target.indexOf("/");
	const provider = separator > 0 ? target.slice(0, separator) : undefined;
	const scoped = provider === undefined ? models : models.filter((model) => model.provider.toLowerCase() === provider);
	// A bare model ID may itself contain slashes, so check it before interpreting a provider scope.
	const exactIds = models.filter((model) => model.id.toLowerCase() === target);
	const exactNames = models.filter((model) => model.name.toLowerCase() === target);
	const pattern = provider === undefined ? target : target.slice(separator + 1);
	const scopedIds = scoped.filter((model) => model.id.toLowerCase() === pattern);
	const scopedNames = scoped.filter((model) => model.name.toLowerCase() === pattern);
	let matches = exactIds;
	if (matches.length === 0) matches = exactNames;
	if (matches.length === 0) matches = scopedIds;
	if (matches.length === 0) matches = scopedNames;
	if (matches.length === 0) {
		matches = scoped.filter(
			(model) => model.id.toLowerCase().includes(pattern) || model.name.toLowerCase().includes(pattern),
		);
	}
	if (matches.length > 1) {
		const candidates = matches.map(canonicalModel).sort();
		return {
			reason: `matches multiple native Pi models (ambiguous; specify provider/modelId): ${candidates.join(", ")}`,
		};
	}
	const model = matches[0];
	return model ? { model } : { reason: "is not registered in the native Pi model runtime" };
}

/** Native models visible to isolated children: same dedupe by canonical reference form as the resolver. */
function nativeModels(runtime: ModelRuntime): NativeModel[] {
	return [...new Map(runtime.getModels().map((model) => [canonicalModel(model), model])).values()];
}

/** Create the isolated native runtime the admission resolver reads configuration from. */
function createIsolatedRuntime(agentDir: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

/** Re-read on-disk model/auth configuration without allowing network access. */
async function refreshOffline(runtime: ModelRuntime): Promise<ModelRuntime> {
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

/**
 * List the native Pi models isolated children can see, so callers can disambiguate an ambiguous
 * `provider/modelId` request. Performs no auth checks.
 */
export async function listNativeModels(
	options: { agentDir?: string; query?: string; limit?: number } = {},
): Promise<{ total: number; rows: Array<{ ref: string; name: string }> }> {
	const runtime = await refreshOffline(await createIsolatedRuntime(options.agentDir ?? getAgentDir()));
	const query = options.query?.trim().toLowerCase();
	const rows = nativeModels(runtime)
		.filter(
			(model) =>
				!query || canonicalModel(model).toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
		)
		.map((model) => ({ ref: canonicalModel(model), name: model.name }))
		.sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
	return { total: rows.length, rows: rows.slice(0, Math.max(0, options.limit ?? 50)) };
}

/** Resolve the same global models/auth configuration that isolated native children load. */
export function createModelAdmission(
	options: { agentDir?: string; getParentModel?: () => string | undefined } = {},
): (input: ModelAdmissionInput) => Promise<ModelAdmission> {
	const agentDir = options.agentDir ?? getAgentDir();
	let setup: Promise<ModelRuntime> | undefined;
	let refresh: Promise<ModelRuntime> | undefined;

	function refreshedRuntime(): Promise<ModelRuntime> {
		if (refresh) return refresh;
		const initializing = setup ?? createIsolatedRuntime(agentDir);
		setup = initializing;
		const refreshing = initializing.then(refreshOffline);
		refresh = refreshing;
		void refreshing.then(
			() => {
				if (refresh === refreshing) refresh = undefined;
			},
			() => {
				if (refresh === refreshing) refresh = undefined;
				if (setup === initializing) setup = undefined;
			},
		);
		return refreshing;
	}

	return async (input) => {
		// Capture the live parent before bootstrap I/O or SDK setup can yield to another turn.
		const parent = options.getParentModel?.()?.trim() || undefined;
		const requested = input.model?.trim() || undefined;
		const callerFallback = input.fallbackModel?.trim() || undefined;
		const saved = input.sessionFile
			? (await loadChildBootstrap(join(dirname(input.sessionFile), "bootstrap.json"))).model?.trim() || undefined
			: undefined;
		const primary = requested ?? saved ?? parent;
		let runtime: ModelRuntime;
		try {
			runtime = await refreshedRuntime();
		} catch {
			// Native errors can contain command output or credential details; never expose them.
			throw new Error("No authenticated model is available: native Pi model/auth setup failed.");
		}

		const models = nativeModels(runtime);
		const triedModels = new Set<string>();
		const triedReferences = new Set<string>();
		const providerAuth = new Map<string, Promise<boolean>>();
		const unavailableProviders = new Set<string>();
		let primaryReason: string | undefined;

		async function usable(model: NativeModel): Promise<boolean> {
			if (unavailableProviders.has(model.provider)) return false;
			try {
				// Native resolution preserves headers-only/ambient/OAuth auth and checks model headers.
				const resolution = await runtime.getAuth(model);
				if (resolution === undefined) unavailableProviders.add(model.provider);
				return resolution !== undefined;
			} catch {
				// Distinguish bad provider auth from a single model's failed configured headers.
				// A provider exception must not block another provider or be retried for every model.
				let auth = providerAuth.get(model.provider);
				if (!auth) {
					auth = runtime.getAuth(model.provider).then(
						(resolution) => resolution !== undefined,
						() => false,
					);
					providerAuth.set(model.provider, auth);
				}
				if (!(await auth)) unavailableProviders.add(model.provider);
				return false;
			}
		}

		function selected(model: NativeModel): ModelAdmission {
			const canonical = canonicalModel(model);
			return primary && primaryReason
				? {
						model: canonical,
						fallback: `Requested model ${JSON.stringify(primary)} ${primaryReason}; selected ${canonical}.`,
					}
				: { model: canonical };
		}

		for (const reference of [primary, callerFallback, parent]) {
			if (!reference || triedReferences.has(reference.toLowerCase())) continue;
			triedReferences.add(reference.toLowerCase());
			const resolution = resolveModel(reference, models);
			if ("reason" in resolution) {
				// A strict explicit request must fail loudly instead of degrading to another model.
				if (input.strict === true && reference === requested) {
					throw new Error(`Requested model ${JSON.stringify(reference)} ${resolution.reason}.`);
				}
				if (reference === primary) primaryReason = resolution.reason;
				continue;
			}
			const canonical = canonicalModel(resolution.model);
			if (triedModels.has(canonical)) continue;
			triedModels.add(canonical);
			if (await usable(resolution.model)) return selected(resolution.model);
			if (reference === primary) primaryReason = "has no usable native authentication (missing or failed)";
		}

		// Stable provider/model ordering, independent of config insertion order and locale.
		models.sort((left, right) => {
			const a = canonicalModel(left);
			const b = canonicalModel(right);
			return a < b ? -1 : a > b ? 1 : 0;
		});
		for (const model of models) {
			const canonical = canonicalModel(model);
			if (triedModels.has(canonical)) continue;
			triedModels.add(canonical);
			if (await usable(model)) return selected(model);
		}
		const detail = primary && primaryReason ? ` Requested model ${JSON.stringify(primary)} ${primaryReason}.` : "";
		throw new Error(`No authenticated model is available in the native Pi child configuration.${detail}`);
	};
}
