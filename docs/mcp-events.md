# MCP Events

Implements authenticated `events/list`, `events/subscribe`, and `events/unsubscribe` on the MCP endpoint with `server/discover` advertising `capabilities.events` when configured. Reference-only event payloads use Standard Webhooks HMAC-SHA256 signatures, fresh delivery timestamps, stable event IDs, HTTPS callback challenge verification, finite leases, and bounded retries. A 410 response removes a subscription; 413 and permanent client errors stop retries. Duplicate delivery is possible; receivers must deduplicate `eventId`.

Callbacks must use public HTTPS on port 443. Every attempt resolves DNS afresh, rejects private/special destinations and connects to the validated address while retaining TLS hostname verification. Redirects are never followed. Callback receipts are limited to 16 KiB; event bodies to 256 KiB. Subscriptions and pending delivery credentials are encrypted at rest. Retrieve full content using the existing authenticated read tools.

## Events and configuration

`memory.created` and `memory.updated` require string `workspace_id`; payloads contain only `workspace_id` and `entry_id`. The durable audit journal supplies created, edited, appended, and status-change observations. Workspace membership and the subscribing OAuth access credential are rechecked before delivery; revocation or expiry stops delivery. A refreshed subscription updates the encrypted credential. Existing static bearer tokens retain their own validation path.

Configure `MCP_EVENTS_RELAY_URL` and secret `MCP_EVENTS_RELAY_TOKEN` for the authenticated Node relay in `yusoofsh/infrastruct-mcp`. Without both, events are disabled and the minute cron does no event work. The new cron has a separate invocation from existing maintenance jobs. Event state is encrypted in the `mcp_event_state` D1 table using the existing deployment secret. Changing that secret requires draining event state first.

Maximum lease: 24 hours, subject to access-token validity. `cursor:null`: no client historical replay. Audit rows are read in bounded batches; latency can exceed one minute during backlog.

## Verification and rollout

Local tests cover the event contract with test callback receipts, temporary durable stores, and relevant authenticated MCP transports. These checks do not establish live ChatGPT subscription delivery. After deployment, rescan the plugin, create a subscription, receive and validate the callback, verify refresh/unsubscribe/revocation, restart the service and confirm recovery. Keep activation disabled until runtime configuration is present.

Reference: https://developers.openai.com/plugins/build/mcp-events
