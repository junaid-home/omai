#!/bin/sh
set -e

# Allow the backend (control plane) host to be overridden at runtime so the
# frontend can be deployed as a separate service from the control plane.
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
sed -i "s/127\\.0\\.0\\.1/${BACKEND_HOST}/g" /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
