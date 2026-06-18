#!/bin/bash
set -a
source /workspace/.env.aimeecloud
set +a
cd /workspace
exec node aimeecloud-audio-gateway.js
