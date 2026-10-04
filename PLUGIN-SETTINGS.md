# Persistent plugin settings

The modern authenticated endpoint advertises `openai/settings` with `plugin_settings_read` and `plugin_settings_update`. The tools return the documented native settings schema, layout and all effective values. The legacy endpoint keeps its existing tool catalog and behavior.

Preferences fill omitted result limits, project and layer for future `list_recent` and `recall` calls. Explicit tool arguments take priority. Settings do not grant access, change workspace membership, change sharing defaults, or modify a memory. The original read tool still checks project access.

Storage is keyed by the identity from the existing authorization boundary, never by an input user ID. Reads do not create a table or write defaults. The first explicit update creates the additive table and merges supplied fields inside one atomic D1 batch. A SELECT within that same batch returns the committed effective values, not a later racing read. Concurrent partial updates preserve omitted keys. Invalid fields fail before storage access. Corrupt storage fails closed.

This feature stores no credentials, callbacks or arbitrary URLs. No KV cache is used. Current authorization is required on every request. Rolling back leaves an inert additive table without changing the memory schema.

Acceptance tests cover user isolation, restart reads, concurrent updates, invalid updates, native metadata and actual forwarding to the original read handlers. They verify explicit scope and existing result metadata remain unchanged. Normal Worker, privacy, coverage and desktop release gates remain required. Real host rendering is distinct from protocol and storage fixture tests.

Reference: https://github.com/openai/mcp-extensions/blob/ca16cb3bc015baaa1b849082d8755bbef18770cb/typescript/src/server/settings.ts
