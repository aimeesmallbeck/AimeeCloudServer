/**
 * AimeeCloud Auth Module
 * Shared between HTTP API (aimeecloud-api-v3.js) and MQTT gateway.
 * Provides: DB access, JWT sessions, API key management, Google OAuth helpers.
 */

const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const https = require('https');

const DB_PATH = process.env.AIMEECLOUD_DB || '/workspace/aimeecloud.db';
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const fallback = crypto.randomBytes(32).toString('hex');
  console.warn('[AUTH] JWT_SECRET not set in environment. Using ephemeral secret — all sessions will invalidate on restart.');
  return fallback;
})();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
let db = null;

function getDb() {
  if (db) return db;
  db = new sqlite3.Database(DB_PATH);
  db.run('PRAGMA journal_mode = WAL');
  initTables(db);
  return db;
}

function initTables(database) {
  database.serialize(() => {
    database.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      google_id TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    database.run(`CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT UNIQUE NOT NULL,
      label TEXT DEFAULT 'My Robot',
      tier TEXT DEFAULT 'free',
      is_disabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    database.run(`CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT NOT NULL,
      action TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    database.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`);

    database.run(`CREATE TABLE IF NOT EXISTS invite_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    database.run(`CREATE TABLE IF NOT EXISTS game_engines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      source TEXT DEFAULT 'generated',
      file_path TEXT NOT NULL,
      stationary INTEGER DEFAULT 1,
      capabilities_needed TEXT,
      description TEXT,
      rules_summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      generation_prompt TEXT,
      test_results TEXT
    )`);

    database.run(`CREATE INDEX IF NOT EXISTS idx_game_engines_name ON game_engines(name)`);
  });
}

// Promisified wrappers
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// ---------------------------------------------------------------------------
// JWT Sessions
// ---------------------------------------------------------------------------
function createSessionToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d', issuer: 'aimeecloud' }
  );
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, { issuer: 'aimeecloud' });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
async function findOrCreateUser(email, googleId) {
  let user = await dbGet('SELECT * FROM users WHERE google_id = ?', [googleId]);
  if (user) {
    if (user.email !== email) {
      await dbRun('UPDATE users SET email = ? WHERE id = ?', [email, user.id]);
      user.email = email;
    }
    return user;
  }
  const result = await dbRun(
    'INSERT INTO users (email, google_id) VALUES (?, ?)',
    [email, googleId]
  );
  return { id: result.lastID, email, google_id: googleId };
}

async function getUserById(id) {
  return dbGet('SELECT id, email, created_at FROM users WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Demo Keys (no Google OAuth required for testing)
// ---------------------------------------------------------------------------
// Demo keys are loaded from environment variables so they are not hardcoded in source.
// Set AIMEE_DEMO_KEY_FREE and/or AIMEE_DEMO_KEY_PAID in your .env file.
const DEMO_KEYS = (() => {
  const keys = {};
  if (process.env.AIMEE_DEMO_KEY_FREE) {
    keys[process.env.AIMEE_DEMO_KEY_FREE] = { tier: 'free', label: 'Free Demo' };
  }
  if (process.env.AIMEE_DEMO_KEY_PAID) {
    keys[process.env.AIMEE_DEMO_KEY_PAID] = { tier: 'paid', label: 'Paid Demo' };
  }
  return keys;
})();

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------
function generateApiKey(tier = 'free') {
  const prefix = `ac_${tier}_`;
  return prefix + uuidv4().replace(/-/g, '').slice(0, 16);
}

async function createApiKey(userId, label = 'My Robot', tier = 'free') {
  const key = generateApiKey(tier);
  const result = await dbRun(
    'INSERT INTO api_keys (user_id, key, label, tier) VALUES (?, ?, ?, ?)',
    [userId, key, label, tier]
  );
  return { id: result.lastID, key, label, tier, is_disabled: 0 };
}

async function listApiKeys(userId) {
  return dbAll(
    'SELECT id, key, label, tier, is_disabled, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
}

async function getApiKeyById(id, userId) {
  return dbGet(
    'SELECT id, key, label, tier, is_disabled, created_at, last_used_at FROM api_keys WHERE id = ? AND user_id = ?',
    [id, userId]
  );
}

async function setApiKeyDisabled(id, userId, isDisabled) {
  const result = await dbRun(
    'UPDATE api_keys SET is_disabled = ? WHERE id = ? AND user_id = ?',
    [isDisabled ? 1 : 0, id, userId]
  );
  return result.changes > 0;
}

async function deleteApiKey(id, userId) {
  const result = await dbRun(
    'DELETE FROM api_keys WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  return result.changes > 0;
}

/**
 * Get a key record for validation (used by MQTT gateway).
 * Returns null if key doesn't exist, is disabled, or user doesn't exist.
 * Demo keys return a synthetic record so testing works without Google OAuth.
 */
async function getKeyRecord(apiKey) {
  const row = await dbGet(
    `SELECT k.*, u.email
     FROM api_keys k
     JOIN users u ON k.user_id = u.id
     WHERE k.key = ? AND k.is_disabled = 0`,
    [apiKey]
  );
  if (row) {
    return {
      id: row.id,
      user_id: row.user_id,
      key: row.key,
      label: row.label,
      tier: row.tier,
      is_disabled: row.is_disabled === 1,
      email: row.email,
      created_at: row.created_at,
      last_used_at: row.last_used_at
    };
  }

  // Return synthetic record for demo keys (testing / no OAuth)
  const demo = DEMO_KEYS[apiKey];
  if (demo) {
    const now = new Date().toISOString();
    return {
      id: 0,
      user_id: 0,
      key: apiKey,
      label: demo.label,
      tier: demo.tier,
      is_disabled: false,
      email: 'demo@aimeecloud.local',
      created_at: now,
      last_used_at: now
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Usage Logging
// ---------------------------------------------------------------------------
async function logUsage(apiKey, action) {
  await dbRun('INSERT INTO usage_logs (api_key, action) VALUES (?, ?)', [apiKey, action]);
}

// ---------------------------------------------------------------------------
// Invite Requests
// ---------------------------------------------------------------------------
async function createInviteRequest(email) {
  try {
    const result = await dbRun(
      'INSERT INTO invite_requests (email) VALUES (?)',
      [email]
    );
    return { id: result.lastID, email, status: 'pending' };
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      const existing = await dbGet('SELECT * FROM invite_requests WHERE email = ?', [email]);
      return { id: existing.id, email: existing.email, status: existing.status, already_exists: true };
    }
    throw err;
  }
}

async function listInviteRequests(status = null) {
  if (status) {
    return dbAll('SELECT * FROM invite_requests WHERE status = ? ORDER BY created_at DESC', [status]);
  }
  return dbAll('SELECT * FROM invite_requests ORDER BY created_at DESC');
}

async function approveInviteRequest(id) {
  const result = await dbRun('UPDATE invite_requests SET status = ? WHERE id = ?', ['approved', id]);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Google OAuth Helpers
// ---------------------------------------------------------------------------
function getGoogleAuthUrl(redirectUri) {
  if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not configured');
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    access_type: 'offline',
    prompt: 'consent'
  });
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state
  };
}

function exchangeGoogleCode(code, redirectUri) {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return reject(new Error('Google OAuth credentials not configured'));
    }
    const postData = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error_description || data.error));
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function verifyGoogleIdToken(idToken) {
  return new Promise((resolve, reject) => {
    https.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error));
          if (data.aud !== GOOGLE_CLIENT_ID) return reject(new Error('Invalid token audience'));
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Game Engine Registry CRUD
// ---------------------------------------------------------------------------
async function createGameEngine(engineData) {
  const sql = `INSERT INTO game_engines
    (name, display_name, source, file_path, stationary, capabilities_needed, description, rules_summary, generation_prompt, test_results)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    engineData.name,
    engineData.display_name || engineData.displayName,
    engineData.source || 'generated',
    engineData.file_path || engineData.filePath,
    engineData.stationary !== undefined ? (engineData.stationary ? 1 : 0) : 1,
    typeof engineData.capabilities_needed === 'string' ? engineData.capabilities_needed : JSON.stringify(engineData.capabilities_needed || []),
    engineData.description || '',
    engineData.rules_summary || engineData.rulesSummary || '',
    engineData.generation_prompt || engineData.generationPrompt || '',
    typeof engineData.test_results === 'string' ? engineData.test_results : JSON.stringify(engineData.test_results || {})
  ];
  return dbRun(sql, params);
}

async function getGameEngineByName(name) {
  return dbGet('SELECT * FROM game_engines WHERE name = ?', [name]);
}

async function listGameEngines() {
  return dbAll('SELECT * FROM game_engines ORDER BY created_at DESC', []);
}

async function updateGameEngine(name, updates) {
  const allowed = ['display_name', 'source', 'file_path', 'stationary', 'capabilities_needed', 'description', 'rules_summary', 'generation_prompt', 'test_results'];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (fields.length === 0) return { changes: 0 };
  values.push(name);
  return dbRun(`UPDATE game_engines SET ${fields.join(', ')} WHERE name = ?`, values);
}

async function deleteGameEngine(name) {
  return dbRun('DELETE FROM game_engines WHERE name = ?', [name]);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Config
  JWT_SECRET,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,

  // DB
  getDb,
  dbGet,
  dbAll,
  dbRun,

  // JWT
  createSessionToken,
  verifySessionToken,

  // Users
  findOrCreateUser,
  getUserById,

  // API Keys
  generateApiKey,
  createApiKey,
  listApiKeys,
  getApiKeyById,
  setApiKeyDisabled,
  deleteApiKey,
  getKeyRecord,

  // Usage
  logUsage,

  // Invite Requests
  createInviteRequest,
  listInviteRequests,
  approveInviteRequest,

  // Game Engines
  createGameEngine,
  getGameEngineByName,
  listGameEngines,
  updateGameEngine,
  deleteGameEngine,

  // Google OAuth
  getGoogleAuthUrl,
  exchangeGoogleCode,
  verifyGoogleIdToken
};
