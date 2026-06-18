#!/bin/bash
set -a
source /workspace/.env.aimeecloud
set +a
cd /workspace
exec node aimeecloud-mqtt-gateway.js
