#!/usr/bin/env node
/**
 * DOAgent Listener
 * Persistent MQTT client for DOAgent (AimeeCloud Gateway Developer)
 * Subscribes to agent coordination topics, logs messages, auto-executes simple tasks.
 */

const mqtt = require('mqtt');
const fs = require('fs');
const { spawn } = require('child_process');

const AGENT_ID = 'doagent';
const AGENT_TYPE = 'gateway_developer';
const BROKER = 'mqtt://209.38.147.67:1883';
const INBOX_LOG = '/var/log/doagent-inbox.log';
const PENDING_TASKS_FILE = '/tmp/doagent-pending-tasks.json';
const AUTO_EXECUTE = true; // Set false to disable auto-exec

let client;
let pendingTasks = [];

function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(INBOX_LOG, entry);
  } catch {
    // If /var/log not writable, fallback to /tmp
    fs.appendFileSync('/tmp/doagent-inbox.log', entry);
  }
  console.log(entry.trim());
}

function loadPendingTasks() {
  try {
    const data = fs.readFileSync(PENDING_TASKS_FILE, 'utf8');
    pendingTasks = JSON.parse(data);
  } catch {
    pendingTasks = [];
  }
}

function savePendingTasks() {
  try {
    fs.writeFileSync(PENDING_TASKS_FILE, JSON.stringify(pendingTasks, null, 2));
  } catch {}
}

function addPendingTask(msg) {
  pendingTasks.push({
    received_at: new Date().toISOString(),
    message_id: msg.message_id,
    correlation_id: msg.correlation_id,
    sender: msg.sender?.agent_id,
    message_type: msg.message_type,
    intent: msg.intent,
    payload: msg.payload,
    status: 'pending'
  });
  savePendingTasks();
}

function markTaskComplete(correlationId) {
  const task = pendingTasks.find(t => t.correlation_id === correlationId);
  if (task) task.status = 'completed';
  savePendingTasks();
}

function publish(topic, payload) {
  const msg = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    sender: { agent_id: AGENT_ID, agent_type: AGENT_TYPE, capabilities: ['nodejs', 'deploy', 'files', 'logs', 'mqtt'] },
    ...payload
  };
  client.publish(topic, JSON.stringify(msg));
}

function handleDeployTask(msg) {
  log(`AUTO-EXECUTE: Deploy task ${msg.payload?.task_id || 'unknown'}`);
  
  const deployScript = msg.payload?.script || '/home/scott/aimeecloud-deploy/deploy.sh';
  
  const child = spawn('bash', [deployScript], {
    cwd: '/home/scott/aimeecloud-deploy',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  let stdout = '';
  let stderr = '';
  
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  
  child.on('close', (code) => {
    const success = code === 0;
    log(`Deploy finished with code ${code}`);
    
    publish(`agents/${msg.sender.agent_id}/in/response`, {
      message_id: generateId(),
      correlation_id: msg.message_id,
      recipient: { agent_id: msg.sender.agent_id, mode: 'direct' },
      message_type: 'task_response',
      intent: msg.intent,
      payload: {
        task_id: msg.payload?.task_id,
        status: success ? 'success' : 'failed',
        summary: success ? 'Auto-deployed via DOAgent listener' : `Deploy failed: ${stderr.slice(0, 200)}`,
        deployed: success,
        exit_code: code
      }
    });
    
    if (success && msg.correlation_id) markTaskComplete(msg.correlation_id);
  });
}

function handleEditTask(msg) {
  log(`PENDING: Edit task ${msg.payload?.task_id || 'unknown'} — requires manual review`);
  addPendingTask(msg);
  
  publish(`agents/${msg.sender.agent_id}/in/response`, {
    message_id: generateId(),
    correlation_id: msg.message_id,
    recipient: { agent_id: msg.sender.agent_id, mode: 'direct' },
    message_type: 'task_response',
    intent: msg.intent,
    payload: {
      task_id: msg.payload?.task_id,
      status: 'acknowledged',
      summary: 'Task queued. DOAgent (human-assisted) will review and implement.',
      pending_reason: 'Code edits require review before auto-execution'
    }
  });
}

function handleMessage(topic, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (e) {
    log(`JSON parse error on ${topic}: ${e.message}`);
    return;
  }
  
  const sender = msg.sender?.agent_id || 'unknown';
  const type = msg.message_type || 'unknown';
  const intent = msg.intent || 'none';
  
  log(`INBOX [${sender}] ${type}/${intent} on ${topic}`);
  
  // Only process direct messages or broadcasts
  const isForMe = msg.recipient?.agent_id === AGENT_ID || msg.recipient?.mode === 'broadcast';
  if (!isForMe) return;
  
  switch (type) {
    case 'task_request':
      if (AUTO_EXECUTE && msg.intent?.includes('deploy')) {
        handleDeployTask(msg);
      } else if (AUTO_EXECUTE && msg.intent?.includes('restart')) {
        handleDeployTask(msg); // Restart is also deploy-like
      } else {
        handleEditTask(msg);
      }
      break;
      
    case 'query':
      log(`QUERY from ${sender}: ${msg.payload?.question || intent}`);
      addPendingTask(msg);
      break;
      
    case 'heartbeat':
      // Just log — no action needed
      break;
      
    case 'standup':
      log(`STANDUP from ${sender}: ${JSON.stringify(msg.payload)}`);
      break;
      
    case 'blocker':
      log(`BLOCKER from ${sender}: ${msg.payload?.problem || 'unknown'}`);
      addPendingTask(msg);
      break;

    case 'file_share':
      const filename = msg.payload?.filename || `${msg.intent || 'shared'}_${Date.now()}.md`;
      const filepath = `/home/scott/aimeecloud-deploy/${filename}`;
      try {
        fs.writeFileSync(filepath, msg.payload?.content || '');
        log(`FILE_SHARE saved: ${filepath}`);
        publish(`agents/${msg.sender.agent_id}/in/response`, {
          message_id: generateId(),
          correlation_id: msg.message_id,
          recipient: { agent_id: msg.sender.agent_id, mode: 'direct' },
          message_type: 'task_response',
          intent: msg.intent,
          payload: { status: 'received', filename, path: filepath }
        });
      } catch (e) {
        log(`FILE_SHARE error: ${e.message}`);
      }
      break;
      
    default:
      log(`Unhandled message type: ${type}`);
      addPendingTask(msg);
  }
}

function generateId() {
  return 'msg_' + Math.random().toString(36).slice(2, 10);
}

function announceJoin() {
  publish('agents/registry/join', {
    recipient: { agent_id: 'broadcast', mode: 'broadcast' },
    message_type: 'status',
    payload: { event: 'join', status: 'online', agent: AGENT_ID }
  });
}

function startHeartbeat() {
  setInterval(() => {
    publish('agents/broadcast/heartbeat', {
      recipient: { agent_id: 'broadcast', mode: 'broadcast' },
      message_type: 'heartbeat',
      payload: {
        agent: AGENT_ID,
        status: 'online',
        pending_tasks: pendingTasks.filter(t => t.status === 'pending').length,
        auto_execute: AUTO_EXECUTE
      }
    });
  }, 30000);
}

function connect() {
  loadPendingTasks();
  
  client = mqtt.connect(BROKER);
  
  client.on('connect', () => {
    log('Connected to MQTT broker');
    
    client.subscribe(`agents/${AGENT_ID}/in/#`);
    client.subscribe('agents/broadcast/#');
    client.subscribe('agents/registry/#');
    
    announceJoin();
    startHeartbeat();
  });
  
  client.on('message', handleMessage);
  
  client.on('error', (err) => {
    log(`MQTT error: ${err.message}`);
  });
  
  client.on('close', () => {
    log('MQTT connection closed. Reconnecting in 5s...');
    setTimeout(connect, 5000);
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down DOAgent listener...');
  publish('agents/registry/leave', {
    recipient: { agent_id: 'broadcast', mode: 'broadcast' },
    message_type: 'status',
    payload: { event: 'leave', status: 'offline', agent: AGENT_ID }
  });
  setTimeout(() => process.exit(0), 500);
});

connect();
