// validator.js — Syntax check + contract compliance
const vm = require('vm');

const REQUIRED_EXPORTS = ['name', 'createState', 'makeMove', 'buildResponse'];
const OPTIONAL_EXPORTS = ['displayName', 'stationary', 'modes', 'agentMove', 'normalizeState', 'reset', 'getHint', 'getRules'];

function validateSyntax(code) {
  try {
    new vm.Script(code);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function validateContract(code) {
  const sandbox = { module: { exports: {} }, require: () => ({}), console };
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(code, context, { timeout: 5000 });
    const exports = sandbox.module.exports;
    const missing = REQUIRED_EXPORTS.filter(k => typeof exports[k] === 'undefined');
    const present = OPTIONAL_EXPORTS.filter(k => typeof exports[k] !== 'undefined');
    if (missing.length > 0) {
      return { valid: false, error: `Missing required exports: ${missing.join(', ')}`, missing, present };
    }
    return { valid: true, exports: { name: exports.name, displayName: exports.displayName, stationary: exports.stationary, modes: exports.modes }, present };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function runBasicTests(code) {
  const sandbox = { module: { exports: {} }, require: () => ({}), console };
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(code, context, { timeout: 10000 });
    const engine = sandbox.module.exports;
    const results = [];

    // Test createState
    try {
      const state = engine.createState({ voice: true, display: true, snapshot: false });
      results.push({ test: 'createState', passed: state && state.status === 'playing' });
    } catch (e) { results.push({ test: 'createState', passed: false, error: e.message }); }

    // Test makeMove
    try {
      const state = engine.createState({ voice: true, display: true, snapshot: false });
      const moveResult = engine.makeMove(state, {}, 'player');
      results.push({ test: 'makeMove', passed: moveResult && (moveResult.success || moveResult.error) });
    } catch (e) { results.push({ test: 'makeMove', passed: false, error: e.message }); }

    // Test buildResponse
    try {
      const state = engine.createState({ voice: true, display: true, snapshot: false });
      const resp = engine.buildResponse(state, {});
      results.push({ test: 'buildResponse', passed: resp && typeof resp.text === 'string' && typeof resp.tts === 'string' });
    } catch (e) { results.push({ test: 'buildResponse', passed: false, error: e.message }); }

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    return { valid: failed === 0, results, passed, failed };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function validateEngine(code) {
  const syntax = validateSyntax(code);
  if (!syntax.valid) return { approved: false, stage: 'syntax', ...syntax };

  const contract = validateContract(code);
  if (!contract.valid) return { approved: false, stage: 'contract', ...contract };

  const tests = runBasicTests(code);
  if (!tests.valid) return { approved: false, stage: 'tests', ...tests };

  return { approved: true, stage: 'all', contract, tests };
}

module.exports = { validateEngine, validateSyntax, validateContract, runBasicTests };
