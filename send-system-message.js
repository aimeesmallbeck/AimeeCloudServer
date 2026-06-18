#!/usr/bin/env node
/**
 * AimeeCloud System Message Sender
 * Pushes operational messages to robots via MQTT
 *
 * Usage:
 *   node send-system-message.js --device arduino-uno-q-001 --type protocol_update --msg-id proto-v2 --data '{"version":"2.0"}'
 *   node send-system-message.js --device arduino-uno-q-001 --type diagnostics_request --msg-id diag-01
 *   node send-system-message.js --device arduino-uno-q-001 --type config_update --msg-id cfg-01 --data '{"tts_volume":0.8}'
 */

const mqtt = require('mqtt');

function showHelp() {
  console.log(`Usage: node send-system-message.js [options]

Options:
  --device    <device_id>   Target robot device ID
  --type      <message_type>  protocol_update | config_update | diagnostics_request | restart | firmware_available
  --msg-id    <string>      Unique message ID
  --data      <json>        Additional payload data (JSON string)
  --broker    <url>         MQTT broker URL (default: mqtt://127.0.0.1:1883)
  --help                    Show this help

Examples:
  node send-system-message.js --device arduino-uno-q-001 --type protocol_update --msg-id proto-v2-20260414 --data '{"version":"2.0","url":"https://aimeecloud.com/protocols/robot-protocol-v2.pdf"}'
  node send-system-message.js --device arduino-uno-q-001 --type diagnostics_request --msg-id diag-042
  node send-system-message.js --device arduino-uno-q-001 --type config_update --msg-id cfg-001 --data '{"tts_volume":0.8,"idle_timeout_seconds":30}'
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { broker: 'mqtt://127.0.0.1:1883' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      showHelp();
      process.exit(0);
    } else if (arg === '--device') {
      options.device = args[++i];
    } else if (arg === '--type') {
      options.type = args[++i];
    } else if (arg === '--msg-id') {
      options.msgId = args[++i];
    } else if (arg === '--data') {
      try {
        options.data = JSON.parse(args[++i]);
      } catch (e) {
        console.error('Invalid JSON in --data:', e.message);
        process.exit(1);
      }
    } else if (arg === '--broker') {
      options.broker = args[++i];
    }
  }

  if (!options.device || !options.type) {
    console.error('Error: --device and --type are required.\n');
    showHelp();
    process.exit(1);
  }

  return options;
}

function main() {
  const opts = parseArgs();
  const client = mqtt.connect(opts.broker);

  client.on('connect', () => {
    const topic = `aimeecloud/device/${opts.device}/system`;
    const payload = {
      type: opts.type,
      device_id: opts.device,
      msg_id: opts.msgId || `${opts.type}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      ...(opts.data || {})
    };

    client.publish(topic, JSON.stringify(payload), (err) => {
      if (err) {
        console.error('Failed to publish:', err.message);
        client.end();
        process.exit(1);
      }
      console.log(`Sent ${opts.type} to ${opts.device} on ${topic}`);
      console.log('Payload:', JSON.stringify(payload, null, 2));
      client.end();
      setTimeout(() => process.exit(0), 500);
    });
  });

  client.on('error', (err) => {
    console.error('MQTT error:', err.message);
    process.exit(1);
  });
}

main();
