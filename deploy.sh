#!/bin/bash
set -e

echo "=== AimeeCloud MQTT Deployment Script ==="
echo ""

# 1. Mosquitto WebSocket config
echo "[1/7] Configuring Mosquitto WebSocket listener..."
cp /home/scott/aimeecloud-deploy/mosquitto-websockets.conf /etc/mosquitto/conf.d/websockets.conf

# 2. Nginx update
echo "[2/7] Updating Nginx config..."
NGINX_SITE=/etc/nginx/sites-available/aimeecloud
python3 << 'PY'
snippet = """    location /aimeecloud-mqtt {
        proxy_pass http://127.0.0.1:9001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
    location /ws/v1 {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
"""
content = open('/etc/nginx/sites-available/aimeecloud').read()
marker = "    location ~* \\.(jpg|jpeg|png|gif|ico|css|js)$"
if 'aimeecloud-mqtt' not in content and marker in content:
    content = content.replace(marker, snippet + marker)
    open('/etc/nginx/sites-available/aimeecloud', 'w').write(content)
    print('Nginx config updated.')
else:
    print('Nginx config already contains aimeecloud-mqtt location or marker not found.')
PY

# 3. Install npm dependencies in /workspace
echo "[3/7] Installing Node dependencies in /workspace..."
cd /workspace
if [ ! -f package.json ]; then
    npm init -y
fi
npm install mqtt sqlite3 jsonwebtoken uuid ws
# Optional: Opus codec for audio compression (may require build tools)
npm install @discordjs/opus --optional || echo "Warning: @discordjs/opus optional install failed (build tools may be needed)"

# 4. Copy gateway + supporting files to /workspace
echo "[4/7] Copying MQTT gateway and modules..."
cp /home/scott/aimeecloud-deploy/aimeecloud-mqtt-gateway.js /workspace/aimeecloud-mqtt-gateway.js
cp /home/scott/aimeecloud-deploy/aimeecloud-api-v3.js /workspace/aimeecloud-api-v3.js
cp /home/scott/aimeecloud-deploy/aimeecloud-auth.js /workspace/aimeecloud-auth.js
cp /home/scott/aimeecloud-deploy/elevenlabs-tts.js /workspace/elevenlabs-tts.js
cp /home/scott/aimeecloud-deploy/voiceRegistry.json /workspace/voiceRegistry.json
cp /home/scott/aimeecloud-deploy/tier-config.json /workspace/tier-config.json
cp /home/scott/aimeecloud-deploy/start-mqtt-gateway.sh /workspace/start-mqtt-gateway.sh 2>/dev/null || true
chmod +x /workspace/start-mqtt-gateway.sh 2>/dev/null || true
cp /home/scott/aimeecloud-deploy/start-audio-gateway.sh /workspace/start-audio-gateway.sh 2>/dev/null || true
chmod +x /workspace/start-audio-gateway.sh 2>/dev/null || true

# Copy audio streaming gateway
echo "[4b/7] Copying audio streaming gateway..."
mkdir -p /workspace/audio-providers
cp /home/scott/aimeecloud-deploy/aimeecloud-audio-gateway.js /workspace/aimeecloud-audio-gateway.js
cp /home/scott/aimeecloud-deploy/function-router.js /workspace/function-router.js
cp /home/scott/aimeecloud-deploy/audio-providers/base.js /workspace/audio-providers/base.js
cp /home/scott/aimeecloud-deploy/audio-providers/gemini.js /workspace/audio-providers/gemini.js
cp /home/scott/aimeecloud-deploy/audio-providers/openai.js /workspace/audio-providers/openai.js

# 5. Copy browser client and web pages
echo "[5/7] Copying browser test client and web pages..."
cp /home/scott/aimeecloud-deploy/aimee/index.html /var/www/html/aimeecloud/aimee/index.html
cp /home/scott/aimeecloud-deploy/aimee/robot-simulator.html /var/www/html/aimeecloud/aimee/robot-simulator.html
cp /home/scott/aimeecloud-deploy/login.html /var/www/html/aimeecloud/login.html
cp /home/scott/aimeecloud-deploy/api-keys.html /var/www/html/aimeecloud/api-keys.html
cp /home/scott/aimeecloud-deploy/index.html /var/www/html/aimeecloud/index.html

# 6. Ensure environment file exists
echo "[6/7] Checking environment configuration..."
if [ -f /workspace/.env.aimeecloud ]; then
    echo "  Environment file found."
else
    echo "  WARNING: /workspace/.env.aimeecloud not found."
    echo "  Create it with required vars:"
    echo "    ELEVENLABS_API_KEY=your_key"
    echo "    JWT_SECRET=your_random_secret"
    echo "    GOOGLE_CLIENT_ID=your_google_client_id"
    echo "    GOOGLE_CLIENT_SECRET=your_google_client_secret"
fi

# 7. Restart services
echo "[7/7] Restarting services..."
systemctl restart mosquitto
systemctl reload nginx

# Start or restart the HTTP API service
echo "Starting HTTP API service..."
pkill -f "node aimeecloud-api-v3.js" 2>/dev/null || true
sleep 1
cd /workspace
nohup node aimeecloud-api-v3.js >> /var/log/aimeecloud-api.log 2>&1 &
sleep 2
if pgrep -f "aimeecloud-api-v3.js" > /dev/null; then
    echo "HTTP API service is running on port 3080."
else
    echo "WARNING: HTTP API service failed to start. Check /var/log/aimeecloud-api.log"
fi

# Start or restart the gateway node process
echo "Starting MQTT gateway..."
pkill -f "node aimeecloud-mqtt-gateway.js" 2>/dev/null || true
sleep 1
cd /workspace
nohup /workspace/start-mqtt-gateway.sh >> /var/log/aimeecloud-mqtt-gateway.log 2>&1 &
sleep 2
if pgrep -f "aimeecloud-mqtt-gateway.js" > /dev/null; then
    echo "MQTT gateway is running."
else
    echo "WARNING: MQTT gateway failed to start. Check /var/log/aimeecloud-mqtt-gateway.log"
fi

echo ""
echo "=== Deployment Complete ==="
echo "Test URL: https://aimeecloud.com/aimee"
echo "Gateway log: tail -f /var/log/aimeecloud-mqtt-gateway.log"
