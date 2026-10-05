#!/bin/bash
ssh hetzner "bash -i -c 'cd gamephone-webrtc && git fetch -p && git pull origin main && pm2 restart server-ws'"
