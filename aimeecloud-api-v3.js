const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');

const auth = require('./aimeecloud-auth');

const SESSION_TTL = 600;
const LOG_FILE = '/var/log/aimeecloud-requests.log';

const sessions = new Map();

function logRequest(req) {
    const entry = new Date().toISOString() + ' | ' + req.method + ' ' + req.url + ' | ' + JSON.stringify(req.body) + '\n';
    fs.appendFileSync(LOG_FILE, entry);
}

function classifyIntent(text) {
    const textLower = text.toLowerCase();
    console.log('Classifying:', textLower);
    
    const patterns = {
        'robot_forward': ['forward', 'go', 'move forward', 'ahead'],
        'robot_backward': ['backward', 'back', 'reverse', 'go back'],
        'robot_stop': ['stop', 'halt', 'wait'],
        'robot_left': ['left', 'turn left'],
        'robot_right': ['right', 'turn right'],
        'robot_wave': ['wave', 'dance'],
        'arm_raise': ['raise', 'lift up', 'up'],
        'arm_lower': ['lower', 'put down', 'down'],
        'gripper_open': ['open', 'release', 'let go'],
        'gripper_close': ['close', 'grab', 'hold', 'catch'],
        'weather': ['weather', 'temperature', 'forecast'],
        'news': ['news', 'headlines', 'what happened'],
        'story': ['story', 'tell me a story', 'read', 'dragon', 'fairy tale', 'bedtime'],
        'game': ['game', 'tic-tac-toe', 'chess', 'yahtzee', 'play', 'candyland'],
        'help': ['help', 'what can you do', 'hi', 'hello', 'hey'],
        'status': ['status', 'how are you'],
    };
    
    const sorted = Object.entries(patterns).sort((a, b) => {
        const maxLenA = Math.max(...a[1].map(k => k.length));
        const maxLenB = Math.max(...b[1].map(k => k.length));
        return maxLenB - maxLenA;
    });
    
    for (const [intent, keywords] of sorted) {
        for (const keyword of keywords) {
            if (textLower.includes(keyword)) {
                console.log('Matched:', intent, 'keyword:', keyword);
                let category = 'robot_control';
                if (intent.startsWith('arm_')) category = 'arm_control';
                else if (intent.startsWith('gripper_')) category = 'gripper_control';
                else if (['weather', 'news', 'story', 'game', 'help', 'status'].includes(intent)) category = 'cloud_skill';
                return { intent, category, confidence: 0.85, text, source: 'keyword' };
            }
        }
    }
    return { intent: 'chat', category: 'cloud_skill', confidence: 0.5, text, source: 'default' };
}

const responses = {
    'weather': { text: "The current weather is sunny with a temperature of 72 degrees Fahrenheit.", tts: "It is sunny and 72 degrees outside." },
    'news': { text: "Today: AI technology advances, Arduino releases quantum boards, robot companions grow popular.", tts: "Here are today's headlines." },
    'story': { text: "Once upon a time, in a digital land far beyond the screens, there lived a friendly robot named Aimee who loved adventures.", tts: "Once upon a time..." },
    'game': { text: "Let's play tic-tac-toe! You go first. Pick a square.", tts: "Let's play tic-tac-toe! You go first." },
    'robot_forward': { text: "Moving forward", tts: "Okay, moving forward" },
    'robot_backward': { text: "Moving backward", tts: "Okay, moving backward" },
    'robot_stop': { text: "Stopping", tts: "Okay, stopping" },
    'robot_left': { text: "Turning left", tts: "Okay, turning left" },
    'robot_right': { text: "Turning right", tts: "Okay, turning right" },
    'robot_wave': { text: "Waving hello!", tts: "Hello! Wave wave!" },
    'arm_raise': { text: "Raising arm", tts: "Okay, raising the arm" },
    'arm_lower': { text: "Lowering arm", tts: "Okay, lowering the arm" },
    'gripper_open': { text: "Opening gripper", tts: "Okay, opening the gripper" },
    'gripper_close': { text: "Closing gripper", tts: "Okay, closing the gripper" },
    'help': { text: "I can help with robot control, tell stories, play games, check weather, read news, and have conversations.", tts: "I can help with robot control, stories, games, weather, and more." },
    'status': { text: "I am doing great! Ready to help you with your Arduino UNO Q robot project.", tts: "I am doing great and ready to help!" },
    'chat': { text: "Hey! I'm Aimee. I can help with robot control, tell stories, play games, check weather, or just chat!", tts: "Hey! I'm Aimee." }
};

function getResponse(intent) {
    return responses[intent] || responses['chat'];
}

function callLLM(message) {
    return new Promise((resolve) => {
        console.log('Calling LLM for:', message);
        const postData = JSON.stringify({
            model: 'openrouter/google/gemini-1.5-flash',
            messages: [{ role: 'user', content: 'You are Aimee, a friendly AI assistant. Respond conversationally to: ' + message }],
            max_tokens: 150
        });
        
        const options = {
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (process.env.OPENROUTER_HTTP_API_KEY || ''),
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const reply = data.choices?.[0]?.message?.content || 'I can help with robot control, stories, games, weather, and more!';
                    resolve(reply);
                } catch {
                    resolve('I can help with robot control, stories, games, weather, and more!');
                }
            });
        });
        req.on('error', () => resolve('I can help with robot control, stories, games, weather, and more!'));
        req.write(postData);
        req.end();
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (session.status === 'disconnected' && now - session.disconnected_at > SESSION_TTL * 1000) {
            sessions.delete(id);
            console.log('Session expired:', id);
        }
    }
}, 30000);

// ---------------------------------------------------------------------------
// Auth Helpers
// ---------------------------------------------------------------------------
const COOKIE_NAME = 'aimeecloud_session';
const OAUTH_STATE_COOKIE = 'aimeecloud_oauth_state';

function setCookie(res, name, value, maxAge = 7 * 24 * 60 * 60) {
    const secure = process.env.NODE_ENV === 'production' ? 'Secure;' : '';
    res.setHeader('Set-Cookie', `${name}=${value}; HttpOnly; ${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

function clearCookie(res, name) {
    const secure = process.env.NODE_ENV === 'production' ? 'Secure;' : '';
    res.setHeader('Set-Cookie', `${name}=; HttpOnly; ${secure} SameSite=Lax; Path=/; Max-Age=0`);
}

function parseCookies(req) {
    const raw = req.headers.cookie || '';
    return Object.fromEntries(raw.split(';').filter(Boolean).map(c => {
        const [k, ...v] = c.trim().split('=');
        return [k, v.join('=')];
    }));
}

async function requireAuth(req, res) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    if (!token) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return null;
    }
    const payload = auth.verifySessionToken(token);
    if (!payload) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Session expired' }));
        return null;
    }
    const user = await auth.getUserById(payload.sub);
    if (!user) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'User not found' }));
        return null;
    }
    return user;
}

function getRedirectUri(req) {
    const host = req.headers.host || 'aimeecloud.com';
    return `https://${host}/aimeecloud-api/auth/google/callback`;
}

// ---------------------------------------------------------------------------
// Rate Limiting (in-memory, per-IP)
// ---------------------------------------------------------------------------
const rateLimits = new Map();
function checkRateLimit(ip, action, max = 5, windowMs = 15 * 60 * 1000) {
    const key = `${ip}:${action}`;
    const now = Date.now();
    const entry = rateLimits.get(key);
    if (!entry || now - entry.resetAt > windowMs) {
        rateLimits.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const PORT = 3080;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://aimeecloud.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'application/json');
    
    const parsed = new url.URL(req.url, 'http://localhost:' + PORT);
    const path = parsed.pathname;
    
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    
    const parseBody = () => new Promise((resolve) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => { 
            try { 
                const parsed = JSON.parse(body || '{}'); 
                req.body = parsed;
                resolve(parsed); 
            } catch { resolve({}); } 
        });
    });
    
    parseBody().then(async body => {
        logRequest({ method: req.method, url: path, body: body });
        
        // -------------------------------------------------------------------
        // Auth Endpoints
        // -------------------------------------------------------------------
        if (path === '/api/auth/google' && req.method === 'GET') {
            try {
                const redirectUri = getRedirectUri(req);
                const { url: authUrl, state } = auth.getGoogleAuthUrl(redirectUri);
                setCookie(res, OAUTH_STATE_COOKIE, state, 600);
                res.writeHead(302, { Location: authUrl });
                res.end();
            } catch (err) {
                console.error('Google auth error:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'OAuth not configured', detail: err.message }));
            }
            return;
        }
        
        if (path === '/api/auth/google/callback' && req.method === 'GET') {
            const code = parsed.searchParams.get('code');
            const state = parsed.searchParams.get('state');
            const cookies = parseCookies(req);
            const expectedState = cookies[OAUTH_STATE_COOKIE];
            
            clearCookie(res, OAUTH_STATE_COOKIE);
            
            if (!code) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing authorization code' }));
                return;
            }
            if (state !== expectedState) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid state parameter' }));
                return;
            }
            
            try {
                const redirectUri = getRedirectUri(req);
                const tokenData = await auth.exchangeGoogleCode(code, redirectUri);
                const idTokenData = await auth.verifyGoogleIdToken(tokenData.id_token);
                
                const email = idTokenData.email;
                const googleId = idTokenData.sub;
                
                if (!email || !googleId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid Google token' }));
                    return;
                }
                
                const user = await auth.findOrCreateUser(email, googleId);
                const sessionToken = auth.createSessionToken(user);
                setCookie(res, COOKIE_NAME, sessionToken);
                
                res.writeHead(302, { Location: '/api-keys.html' });
                res.end();
            } catch (err) {
                console.error('OAuth callback error:', err);
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Authentication failed', detail: err.message }));
            }
            return;
        }
        
        if (path === '/api/auth/logout' && req.method === 'POST') {
            clearCookie(res, COOKIE_NAME);
            res.end(JSON.stringify({ success: true }));
            return;
        }
        
        if (path === '/api/auth/me' && req.method === 'GET') {
            const user = await requireAuth(req, res);
            if (!user) return;
            res.end(JSON.stringify({ id: user.id, email: user.email }));
            return;
        }
        
        // -------------------------------------------------------------------
        // Invite Request Endpoints
        // -------------------------------------------------------------------
        if (path === '/api/invites' && req.method === 'POST') {
            const email = (body.email || '').trim().toLowerCase();
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Valid email required' }));
                return;
            }
            if (!checkRateLimit(req.socket.remoteAddress, 'invite', 3, 60 * 60 * 1000)) {
                res.writeHead(429);
                res.end(JSON.stringify({ error: 'Too many requests. Try again later.' }));
                return;
            }
            try {
                const result = await auth.createInviteRequest(email);
                res.end(JSON.stringify({ success: true, email: result.email, status: result.status, already_exists: !!result.already_exists }));
            } catch (err) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to save request' }));
            }
            return;
        }
        
        // Admin endpoints (protected by ADMIN_TOKEN header)
        const adminToken = req.headers['x-admin-token'] || '';
        const expectedAdminToken = process.env.ADMIN_TOKEN || '';
        
        if (path === '/api/admin/invites' && req.method === 'GET') {
            if (!expectedAdminToken || adminToken !== expectedAdminToken) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Forbidden' }));
                return;
            }
            const status = parsed.searchParams.get('status');
            const invites = await auth.listInviteRequests(status);
            res.end(JSON.stringify(invites));
            return;
        }
        
        const inviteMatch = path.match(/^\/api\/admin\/invites\/(\d+)$/);
        if (inviteMatch && req.method === 'POST') {
            if (!expectedAdminToken || adminToken !== expectedAdminToken) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Forbidden' }));
                return;
            }
            const inviteId = parseInt(inviteMatch[1], 10);
            const success = await auth.approveInviteRequest(inviteId);
            if (!success) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Invite not found' }));
                return;
            }
            res.end(JSON.stringify({ success: true }));
            return;
        }
        
        // -------------------------------------------------------------------
        // API Key Endpoints
        // -------------------------------------------------------------------
        if (path === '/api/keys' && req.method === 'GET') {
            const user = await requireAuth(req, res);
            if (!user) return;
            const keys = await auth.listApiKeys(user.id);
            // Mask the key values (show only last 4 chars)
            const masked = keys.map(k => ({
                ...k,
                key: k.key.slice(0, 8) + '...' + k.key.slice(-4),
                is_disabled: k.is_disabled === 1
            }));
            res.end(JSON.stringify(masked));
            return;
        }
        
        if (path === '/api/keys' && req.method === 'POST') {
            const user = await requireAuth(req, res);
            if (!user) return;
            const label = (body.label || 'My Robot').trim().slice(0, 100);
            const tier = ['free', 'paid'].includes(body.tier) ? body.tier : 'free';
            const keyRecord = await auth.createApiKey(user.id, label, tier);
            res.end(JSON.stringify({
                id: keyRecord.id,
                key: keyRecord.key,
                label: keyRecord.label,
                tier: keyRecord.tier,
                created_at: new Date().toISOString()
            }));
            return;
        }
        
        const keyMatch = path.match(/^\/api\/keys\/(\d+)$/);
        if (keyMatch && req.method === 'PATCH') {
            const user = await requireAuth(req, res);
            if (!user) return;
            const keyId = parseInt(keyMatch[1], 10);
            const success = await auth.setApiKeyDisabled(keyId, user.id, body.is_disabled);
            if (!success) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Key not found' }));
                return;
            }
            res.end(JSON.stringify({ success: true }));
            return;
        }
        
        if (keyMatch && req.method === 'DELETE') {
            const user = await requireAuth(req, res);
            if (!user) return;
            const keyId = parseInt(keyMatch[1], 10);
            const success = await auth.deleteApiKey(keyId, user.id);
            if (!success) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Key not found' }));
                return;
            }
            res.end(JSON.stringify({ success: true }));
            return;
        }
        
        // -------------------------------------------------------------------
        // Existing API Endpoints
        // -------------------------------------------------------------------
        if (path === '/api/sessions' && req.method === 'GET') {
            res.end(JSON.stringify(Array.from(sessions.values()).map(s => ({ session_id: s.session_id, device_id: s.device_id, status: s.status }))));
            return;
        }
        
        if (path === '/api/sessions/init' && req.method === 'POST') {
            const session_id = 'sess_' + crypto.randomBytes(8).toString('hex');
            const session = { session_id, device_id: body.device_id || 'unknown', user_profile: body.user_profile || {}, active_context: null, context_stack: [], state_data: {}, created_at: new Date().toISOString(), last_activity: new Date().toISOString(), status: 'connected', ttl: SESSION_TTL, disconnected_at: null };
            sessions.set(session_id, session);
            console.log('Session created:', session_id);
            res.end(JSON.stringify({ session_id, websocket_url: 'wss://aimeecloud.com/aimeecloud-ws', expires_in: SESSION_TTL, ...session }));
            return;
        }
        
        const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
        const processMatch = path.match(/^\/api\/sessions\/([^/]+)\/process$/);
        
        if (sessionMatch && req.method === 'GET') {
            const session = sessions.get(sessionMatch[1]);
            if (!session) { res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return; }
            res.end(JSON.stringify(session));
            return;
        }
        
        if (sessionMatch && req.method === 'DELETE') {
            sessions.delete(sessionMatch[1]);
            res.end(JSON.stringify({ status: 'deleted' }));
            return;
        }
        
        if (processMatch && req.method === 'POST') {
            const id = processMatch[1];
            const session = sessions.get(id);
            if (!session) { res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return; }
            
            const { command, intent, device_id } = body;
            session.last_activity = new Date().toISOString();
            session.active_context = intent?.category || 'chat';
            sessions.set(id, session);
            
            const intentVal = intent?.intent || intent?.category || 'chat';
            
            if (intentVal === 'chat') {
                const llmResponse = await callLLM(command);
                res.end(JSON.stringify({ success: true, session, response: { text: llmResponse, tts: llmResponse } }));
                return;
            }
            
            const response = getResponse(intentVal);
            console.log('Process:', id, 'intent:', intentVal);
            res.end(JSON.stringify({ success: true, session, response }));
            return;
        }
        
        if (path === '/api/intent/classify' && req.method === 'POST') {
            const result = classifyIntent(body.text || '');
            console.log('Intent classify result:', result);
            res.end(JSON.stringify(result));
            return;
        }
        
        if (path === '/api/chat' && req.method === 'POST') {
            const { message, session_id } = body;
            if (session_id && sessions.has(session_id)) {
                const session = sessions.get(session_id);
                session.last_activity = new Date().toISOString();
                session.active_context = 'chat';
                sessions.set(session_id, session);
            }
            const intent = classifyIntent(message);
            
            if (intent.intent === 'chat') {
                const llmResponse = await callLLM(message);
                res.end(JSON.stringify({ message: llmResponse, tts: llmResponse, response: { text: llmResponse, tts: llmResponse }, intent }));
                return;
            }
            
            const response = getResponse(intent.intent);
            res.end(JSON.stringify({ message: response.text, tts: response.tts, response, intent }));
            return;
        }
        
        // -------------------------------------------------------------------
        // Game Engine Endpoints
        // -------------------------------------------------------------------
        if (path === '/api/engines' && req.method === 'GET') {
            try {
                const engines = await auth.listGameEngines();
                res.end(JSON.stringify(engines));
            } catch (err) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        const engineMatch = path.match(/^\/api\/engines\/([^/]+)$/);
        if (engineMatch && req.method === 'GET') {
            const name = engineMatch[1];
            try {
                const engine = await auth.getGameEngineByName(name);
                if (!engine) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Engine not found' }));
                    return;
                }
                res.end(JSON.stringify(engine));
            } catch (err) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        // Admin-only: trigger engine generation
        if (path === '/api/admin/engines/generate' && req.method === 'POST') {
            const user = await requireAuth(req, res);
            if (!user) return;
            // TODO: check admin role
            const { game_name } = body;
            if (!game_name) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'game_name is required' }));
                return;
            }
            // Queue generation request (async)
            res.writeHead(202);
            res.end(JSON.stringify({ queued: true, game_name, message: 'Engine generation started' }));
            return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    });
});

// Attach native audio streaming gateway (optional — fails gracefully if module missing)
try {
  const audioGateway = require('./aimeecloud-audio-gateway');
  audioGateway.attachToServer(server, '/ws/v1');
  console.log('Audio streaming gateway attached on /ws/v1');
} catch (err) {
  console.warn('Audio streaming gateway not available:', err.message);
}

server.listen(PORT, () => { console.log('AimeeCloud API running on', PORT); });
