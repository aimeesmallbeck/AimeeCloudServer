// generator.js — LLM engine code generation
const fs = require('fs');
const path = require('path');
const { callLLM } = require('./designer');

const GENERATE_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'generate.txt'), 'utf8');

function toKebab(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function toTitle(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

async function generateEngine(gameName, design, libraryInfo) {
  const gameNameKebab = toKebab(gameName);
  const gameNameTitle = toTitle(gameName);

  const prompt = GENERATE_PROMPT
    .replace('{game_name}', gameName)
    .replace('{game_name_kebab}', gameNameKebab)
    .replace('{Game Name}', gameNameTitle)
    .replace('{rules_summary}', design.rules_summary || 'Simple turn-based game.')
    .replace('{state_schema}', design.state_schema || '{}')
    .replace('{library_name}', libraryInfo?.library || 'none')
    .replace('{library_usage_example}', libraryInfo?.library ? `Use require('${libraryInfo.library}')` : 'Implement from scratch.');

  const raw = await callLLM(prompt);
  // Strip markdown fences if present
  let code = raw.replace(/```javascript\s*/gi, '').replace(/```js\s*/gi, '').replace(/```\s*$/gm, '').trim();
  return { code, gameNameKebab };
}

module.exports = { generateEngine, toKebab, toTitle };
