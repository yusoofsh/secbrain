# Persistent plugin settings

The modern authenticated endpoint advertises `openai/settings` with `plugin_settings_read` and `plugin_settings_update`. The tools return the documented native settings schema, layout and all effective values. Hosts without the settings UI can call the same tools. The legacy endpoint keeps its existing tool catalog and behavior.

Preferences set the omitted result limit, project and layer for future `list_recent` and `recall` calls. Explicit tool arguments take priority. Settings do not grant data access, change workspace membership, change capture sharing defaults, or modify a memory. A project filter is revalidated by the original read tool.

Storage is keyed by the identity from the existing authorization boundary, never by a caller-supplied user ID. Reads do not create a table or write defaults. The first explicit settings update creates the additive preferences table in the same D1 transaction as its update. JSON partial updates preserve omitted keys across concurrent writers. Results return only after persistence succeeds. Invalid fields fail before storage access. Corrupt storage fails closed rather than silently replacing preferences.

This feature stores no credentials, callbacks or arbitrary URLs. No KV cache is used. Current authorization is required on every request. Rolling back the application leaves an inert additive table without changing the memory schema.

Acceptance tests cover user isolation, restart reads, concurrent partial updates, invalid updates, native metadata, and explicit-scope precedence. The normal Worker and desktop release gates remain. Real host rendering is distinct from protocol and storage fixture tests.

Reference: https://github.com/openai/mcp-extensions/blob/ca16cb3bc015baaa1b849082d8755bbef18770cb/typescript/src/server/settings.ts
