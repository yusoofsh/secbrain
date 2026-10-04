# Guided memory workflows

Modern clients can call `review_project_memory` with explicit subject, workspace and project, or respond to its multi-round form. Decline/cancel performs no memory read. Accepted choices use the original scoped recall and get tools. At most five full entries are read; results retain source IDs, exact content digests, bounded previews, coverage notices and explicit no-change status. Only exact full-content duplicates are marked as candidates. Similar previews, age or apparent contradictions are not proof of an error. Any correction is a separate operation requiring explicit approval and a fresh access/content check.

The original fifteen legacy tools remain. The modern catalog adds one guided read tool. `secbrain://memory/{id}` resources delegate to the existing get handler on every read; they are private, immediately stale views, not immutable snapshots. Cached identifiers never confer access. App-relative `/memory/<id>` deep links use the same existing read.

Two workflow skills are exposed through complete bounded Skills manifests, exact UTF-8 resource digests and packaged Markdown. Imported OpenAI skill snapshots still require a plugin submission refresh; a Worker deployment alone does not update an installed snapshot.

Validated traceparent crosses compatibility calls while original application metadata is retained. Baggage and arbitrary trace state are not propagated. This is safe propagation, not an end-to-end OpenTelemetry exporter or full provider tracing.

No memory edits, access changes, service credentials, persistent native settings, Tasks, resource streams or historical replay are implemented here. The public guide remains outside ignored private docs, and privacy checks are unchanged. WAMCP is excluded.
