import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
function replace(path, before, after) {
  const source = readFileSync(path, 'utf8');
  if (source.split(before).length !== 2) throw new Error('Expected one reviewed edit in ' + path);
  writeFileSync(path, source.replace(before, after));
}
mkdirSync('src/ui', { recursive: true });
// Vendor the two reviewed source files from the user's other public MCP project.
// This is a one-time source copy, not a runtime network dependency.
for (const [name, expectedBlob] of [['bridge.ts', 'e7ed0d4e0fff24e2b50347e0e001d5cc2a7f5ccf'], ['styles.ts', '9014a96950509da1d261ab4cdc1ab6bbe39a8340']]) {
  const response = await fetch('https://raw.githubusercontent.com/yusoofsh/moodle-mcp/f6bb7080c0e0942672da9284915ced5159b69fd7/src/ui/' + name);
  if (!response.ok) throw new Error('Reviewed source download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  const blob = createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
  if (blob !== expectedBlob) throw new Error('Reviewed source identity mismatch');
  writeFileSync('src/ui/' + name, bytes);
}
replace('src/mcp/server.ts', 'import { z } from "zod";', 'import { registerMemoryExplorer, memoryExplorerMetadata, memoryCards } from "../ui/memory-explorer";\nimport { z } from "zod";');
replace('src/mcp/server.ts', 'const server = new McpServer({ name: "second-brain", version: "1.0.0" });', 'const server = new McpServer({ name: "second-brain", version: "1.0.0" });\n  registerMemoryExplorer(server);');
replace('src/mcp/server.ts', 'description: LIST_RECENT_DESCRIPTION,\n      inputSchema:', 'description: LIST_RECENT_DESCRIPTION,\n      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },\n      _meta: memoryExplorerMetadata,\n      inputSchema:');
replace('src/mcp/server.ts', 'return { content: [{ type: "text", text: notice + renderRecallText(matches, insight, { queryTokens, config: cfg, compoundStale }) }] };', 'return { content: [{ type: "text", text: notice + renderRecallText(matches, insight, { queryTokens, config: cfg, compoundStale }) }], _meta: { explorer: { cards: memoryCards(matches) } } };');
replace('src/mcp/server.ts', '      return { content: [{ type: "text", text }] };\n    }\n  );\n\n  // ── get', '      return { content: [{ type: "text", text }], _meta: { explorer: { cards: memoryCards(rows.slice(0, blocks.length).map(row => ({ id: String(row.id), content: String(row.content), source: row.source, workspace: layerOfRow(identity, row), createdAt: row.created_at }))) } } };\n    }\n  );\n\n  // ── get');
