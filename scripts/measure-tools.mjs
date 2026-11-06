// Development-only reference measurement, not the provider's full request usage.
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import previous from '../reports/v1-tool-schemas.json' with { type: 'json' };
import { createToolDefinitions } from '../lib/tools.js';
import { mkdir, writeFile } from 'node:fs/promises';

const current = createToolDefinitions(() => {});
const previousNames = new Set(previous.map((tool) => tool.name));
const modelShape = (tools) => tools.map(({ name, description, parameters }) => ({
  type: 'function', function: { name, description, parameters },
}));
function measure(tools) {
  const prompt = JSON.stringify(modelShape(tools));
  return { tools: tools.length, schema_utf8_bytes: Buffer.byteLength(prompt), schema_characters: prompt.length, reference_tokens: encode(prompt).length };
}
const before = measure(previous);
const after = measure(current);
const common = measure(current.filter((tool) => previousNames.has(tool.name)));
const report = {
  method: 'o200k_base BPE over minified OpenAI-style function definitions (name, description, parameters).',
  caveat: 'Reference tool-schema tokens only, not full first-turn system/history tokens or provider-specific framing/billing. Runtime model encodings may differ.',
  before_v1: before,
  after_v3: after,
  after_common_tools: common,
  total_token_change: after.reference_tokens - before.reference_tokens,
  common_tool_token_change: common.reference_tokens - before.reference_tokens,
  capabilities_added: current.filter((tool) => !previousNames.has(tool.name)).map((tool) => tool.name),
};
await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeFile(new URL('../reports/tool-prompt-metrics.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
