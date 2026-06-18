// registry.js — Save/load/register engines with gateway
const fs = require('fs');
const path = require('path');

const ENGINES_DIR = '/workspace/game-test/engines/';

function ensureEnginesDir() {
  if (!fs.existsSync(ENGINES_DIR)) {
    fs.mkdirSync(ENGINES_DIR, { recursive: true });
  }
}

function saveEngineToDisk(gameNameKebab, code) {
  ensureEnginesDir();
  const filePath = path.join(ENGINES_DIR, `${gameNameKebab}.js`);
  fs.writeFileSync(filePath, code, 'utf8');
  return filePath;
}

function deleteEngineFromDisk(gameNameKebab) {
  const filePath = path.join(ENGINES_DIR, `${gameNameKebab}.js`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function registerWithGateway(gatewayModule, filePath) {
  try {
    delete require.cache[require.resolve(filePath)];
    const engine = require(filePath);
    if (gatewayModule && gatewayModule.registerGameEngine) {
      gatewayModule.registerGameEngine(engine);
      return { success: true, engine: engine.name };
    }
    return { success: false, error: 'Gateway module does not expose registerGameEngine' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { saveEngineToDisk, deleteEngineFromDisk, registerWithGateway, ENGINES_DIR };
