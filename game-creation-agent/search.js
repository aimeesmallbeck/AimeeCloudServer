// search.js — LLM-based game research (fallback when no search API key is available)
const https = require('https');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';

function callOpenRouter(messages, maxTokens = 800) {
  return new Promise((resolve, reject) => {
    if (!OPENROUTER_API_KEY) {
      return resolve(null);
    }
    const body = JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: maxTokens,
    });
    const req = https.request({
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://aimeecloud.com',
        'X-Title': 'AimeeCloud Game Creation Agent',
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || JSON.stringify(json.error)));
          const text = json.choices?.[0]?.message?.content || '';
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenRouter timeout')); });
    req.write(body);
    req.end();
  });
}

async function searchGameRules(gameName) {
  const prompt = `You are a game encyclopedia. Provide a concise but complete explanation of how to play "${gameName}". Include:
- Number of players
- Objective
- Setup
- Turn structure
- Winning conditions
- Any special rules

Be factual and structured.`;

  try {
    const text = await callOpenRouter([{ role: 'user', content: prompt }], 1200);
    if (text) return text;
  } catch (e) {
    console.error('[search] Rules lookup failed:', e.message);
  }
  return '';
}

async function searchNpmLibraries(gameName) {
  const prompt = `You are a JavaScript package researcher. For the game "${gameName}", tell me if there is a well-known npm package or GitHub library that implements this game logic in JavaScript/Node.js.

If yes, respond ONLY with JSON like:
{"library":"package-name","npm":"package-name","github":"user/repo","notes":"brief description"}

If no well-known library exists, respond with:
{"library":null,"npm":null,"github":null,"notes":"No prominent library found"}`;

  try {
    const text = await callOpenRouter([{ role: 'user', content: prompt }], 400);
    if (!text) return [];
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.library) return [obj];
    }
  } catch (e) {
    console.error('[search] Library lookup failed:', e.message);
  }
  return [];
}

module.exports = { searchGameRules, searchNpmLibraries };
