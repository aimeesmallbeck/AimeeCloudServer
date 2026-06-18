// agent.js — Main Game Creation Agent orchestrator
const { validateGame, designGame } = require('./designer');
const { discoverLibrary } = require('./search');
const { generateEngine } = require('./generator');
const { validateEngine } = require('./validator');
const { saveEngineToDisk, registerWithGateway } = require('./registry');

const MAX_RETRIES = 3;

async function createGameEngine(gameName, capabilities, gatewayModule) {
  const log = (msg, ...args) => console.log(`[GameCreationAgent] ${msg}`, ...args);
  log('Starting creation for:', gameName);

  // 1. Validate appropriateness
  const validation = await validateGame(gameName);
  if (!validation.approved) {
    log('Game rejected:', validation.reason);
    return { success: false, error: validation.reason, stage: 'validation' };
  }

  // 2. Research
  const libraryInfo = await discoverLibrary(gameName);
  log('Library discovery:', libraryInfo.library || 'none');

  // 3. Design
  const design = await designGame(gameName, capabilities);
  if (!design) {
    log('Design step failed');
    return { success: false, error: 'Design generation failed', stage: 'design' };
  }
  log('Design complete:', design.rules_summary);

  // 4. Generate + validate with retries
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log('Generation attempt', attempt);
    const { code, gameNameKebab } = await generateEngine(gameName, design, libraryInfo);

    const result = validateEngine(code);
    if (result.approved) {
      log('Engine validated on attempt', attempt);

      // 5. Save to disk
      const filePath = saveEngineToDisk(gameNameKebab, code);
      log('Saved to', filePath);

      // 6. Register with gateway if available
      let registration = { success: false, error: 'No gateway module provided' };
      if (gatewayModule) {
        registration = registerWithGateway(gatewayModule, filePath);
      }

      return {
        success: true,
        stage: 'complete',
        engine: {
          name: gameNameKebab,
          displayName: design.rules_summary ? gameName : gameNameKebab,
          filePath,
          design,
          validation: result
        },
        registration
      };
    }

    lastError = result.error || 'Validation failed';
    log('Validation failed on attempt', attempt, ':', lastError);
  }

  return { success: false, error: lastError, stage: 'generation', retries: MAX_RETRIES };
}

module.exports = { createGameEngine };
