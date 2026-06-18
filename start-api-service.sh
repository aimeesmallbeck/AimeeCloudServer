#!/bin/bash
set -a
source /workspace/.env.aimeecloud
set +a
cd /workspace
exec node aimeecloud-api-v3.js
