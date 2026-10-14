import { bindings, defineConfig, triggers } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .dev.vars.example. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	worker: {
		name: "secbrain",
		compatibilityDate: "2026-06-17",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		workersDev: true,
		observability: {
			enabled: true,
			headSamplingRate: 1,
			logs: {
				enabled: true,
				invocationLogs: true,
				headSamplingRate: 1,
				persist: true,
			},
			traces: {
				enabled: true,
				headSamplingRate: 1,
				persist: true,
			},
		},
		domains: [
			"secbrain.yusoofsh.id",
		],
		triggers: [
			triggers.scheduled({
				schedule: "0 1 * * *",
			}),
			triggers.scheduled({
				schedule: "30 * * * *",
			}),
			triggers.scheduled({
				schedule: "45 1 * * *",
			}),
			triggers.scheduled({
				schedule: "15 2 * * SUN",
			}),
			triggers.scheduled({
				schedule: "45 2 * * SUN",
			}),
		],
		env: {
			VECTORIZE_GRACE_MS: bindings.text("300000"),
			AUTH_TOKEN: bindings.secret(),
			DB: bindings.d1({
				name: "secbrain",
				id: "eff5d61c-2858-4d22-a056-4681bfd0a00f",
			}),
			OAUTH_KV: bindings.kv({
				id: "7d37ad9ab84049a4ad6b82300ef84f9d",
			}),
			VECTORIZE: bindings.vectorize({
				name: "secbrain",
			}),
			AI: bindings.ai({}),
		},
	},
});
