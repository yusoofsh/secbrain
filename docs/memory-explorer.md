# Memory Explorer

The existing `list_recent` tool will expose an MCP Apps resource and OpenAI sidebar/conversation entrypoints. The planned view reuses `list_recent`, `recall`, `list_projects`, and `get`; it adds no write action and does not change identity, workspace, team, project or corpus access rules.

Result previews are projected only from rows already authorized by the original read handlers. They are bounded and carried in UI metadata; original text responses and ordering remain intact. Reading a selected full memory calls the existing `get` tool, which rechecks access. Sharing selected context with the next chat message is an explicit UI action, not a memory write or message send.

The modern HTTP bridge must forward resources as well as tools. The maintained MCP SDK performs per-request envelope and routing validation before any read or Events action; the existing authenticated handlers remain authoritative for data access. Static HTML contains no user data and requests no external network or resource permissions.

Upstream policy: Secbrain is an original repository, not a registered fork. Do not fabricate an upstream or replace custom history. For maintained forks, verify the actual registered parent before release and merge with tests instead of resetting. WAMCP is retired from maintenance.
