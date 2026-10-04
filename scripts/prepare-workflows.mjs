import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
function replace(path, before, after) {
  const text = readFileSync(path, 'utf8');
  if (text.split(before).length !== 2) throw new Error('Reviewed integration no longer matches: ' + path);
  writeFileSync(path, text.replace(before, after));
}
mkdirSync('src/workflows', { recursive: true }); mkdirSync('src/ui', { recursive: true });
for (const [path, expected] of [['src/workflows/core.ts','dfc557e2781e2a3cef17e45f746a11f42d7aeaae'],['src/ui/deep-link.ts','93c3f886168fd832ccf453abcb1a219d1f3b07ab']]) {
  const response = await fetch('https://raw.githubusercontent.com/yusoofsh/moodle-mcp/34d09452b6008001d29972d0d14b72f9c4595911/' + path);
  if (!response.ok) throw new Error('Reviewed shared source unavailable');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex') !== expected) throw new Error('Reviewed source digest mismatch');
  writeFileSync(path, bytes);
}
// Copy the already reviewed foundation tests; only local module paths differ.
for (const path of ['tests/workflow-foundation.test.ts','tests/deep-link.test.ts']) {
  const response = await fetch('https://raw.githubusercontent.com/yusoofsh/moodle-mcp/33da225b63b8fbfe39745202b0001dedd1a25e7b/' + path);
  if (!response.ok) throw new Error('Reviewed test source unavailable');
  const text = (await response.text()).replaceAll('../src/', '../../src/').replaceAll('/core.js"','/core"').replaceAll('/skills.js"','/skills"').replaceAll('/deep-link.js"','/deep-link"');
  writeFileSync('test/unit/'+path.split('/').at(-1), text);
}
replace('src/mcp/server.ts', 'import { MAX_INPUT_TAGS', 'import { registerWorkflowResources } from "../workflows/resources";\nimport { MAX_INPUT_TAGS');
replace('src/mcp/server.ts', '  registerMemoryExplorer(server);', '  registerMemoryExplorer(server);\n  registerWorkflowResources(server);');
replace('src/ui/bridge.ts', 'function applyContext(context){', 'function applyContext(context){if(context?.["openai/deepLink"]&&typeof onDeepLink==="function")onDeepLink(context["openai/deepLink"]);');
replace('src/ui/memory-explorer.ts', 'import type { McpServer }', 'import { appRoute } from "./deep-link";\nimport type { McpServer }');
replace('src/ui/memory-explorer.ts', "const appName='secbrain-memory-explorer';", "const appName='secbrain-memory-explorer';\nconst appRoute=${String(appRoute)};let requestedMemory=null;");
replace('src/ui/memory-explorer.ts', "function onReady(){if(!hasSnapshot)void runRead('recent');}", "function onDeepLink(value){const route=appRoute(value);if(route?.kind==='memory'){requestedMemory=route.id;if(ready&&!busy){selectedId=requestedMemory;lastOperation='full';void read('get',{id:selectedId});}}}\nfunction onReady(){if(requestedMemory){selectedId=requestedMemory;lastOperation='full';void read('get',{id:selectedId});}else if(!hasSnapshot)void runRead('recent');}");
