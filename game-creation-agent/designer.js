// designer.js — LLM game design step
const fs = require('fs');
const path = require('path');
const https = require('https');

const DESIGN_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'design.txt'), 'utf8');
const VALIDATE_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'validate-game.txt'), 'utf8');

function callLLM(prompt) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'google/gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.OPENROUTER_API_KEY || ''),
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.choices?.[0]?.message?.content || '');
        } catch {
          resolve('');
        }
      });
    });

    req.on('error', () => resolve(''));
    req.write(postData);
    req.end();
  });
}

function extractJson(text) {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (match) return match[1];
  const m2 = text.match(/\{[\s\S]*\}/);
  return m2 ? m2[0] : text;
}

async function validateGame(gameName) {
  const prompt = VALIDATE_PROMPT.replace('{game_name}', gameName);
  const raw = await callLLM(prompt);
  try {
    const json = JSON.parse(extractJson(raw));
    return json;
  } catch {
    return { approved: false, reason: 'Validation parse failed', stationary: false, safe: false, playable_by_voice: false, appropriate: false };
  }
}

async function designGame(gameName, capabilities) {
  const prompt = DESIGN_PROMPT
    .replace('{game_name}', gameName)
    .replace('{caps}', JSON.stringify(capabilities || { voice: true, display: true, snapshot: false }));
  const raw = await callLLM(prompt);
  try {
    const json = JSON.parse(extractJson(raw));
    return json;
  } catch {
    return null;
  }
}

module.exports = { validateGame, designGame, callLLM };
