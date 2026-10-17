#!/usr/bin/env bash
# Create (or refresh) the self-signed origin certificate served by omai-app
# nginx on :443.
#
# Cloudflare terminates the public TLS certificate for app.omai.ch and
# re-encrypts to this LoadBalancer when the zone's SSL mode is "Full". In that
# mode the origin certificate is not verified, so a self-signed one is enough.
# The certificate covers app.omai.ch, preview.omai.ch and *.omai.ch so the same
# secret works for both nginx server blocks.
set -euo pipefail

NAMESPACE="${NAMESPACE:-omai}"
SECRET="${SECRET:-omai-app-tls}"
CN="app.omai.ch"
SAN="DNS:app.omai.ch,DNS:preview.omai.ch,DNS:*.omai.ch,DNS:localhost,IP:127.0.0.1"
DAYS="825"

# Keep an existing certificate unless FORCE=1, so redeploys do not silently
# replace the origin certificate Cloudflare is already trusting.
if kubectl -n "$NAMESPACE" get secret "$SECRET" >/dev/null 2>&1 && [ "${FORCE:-0}" != "1" ]; then
  echo "==> Secret ${NAMESPACE}/${SECRET} already exists (set FORCE=1 to regenerate)."
  exit 0
fi

echo "==> Generating self-signed certificate for ${CN}..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
openssl req -x509 -nodes -newkey rsa:2048 -days "$DAYS" \
  -keyout "$TMP/tls.key" -out "$TMP/tls.crt" \
  -subj "/CN=${CN}" -addext "subjectAltName=${SAN}" >/dev/null 2>&1

echo "==> Applying secret ${NAMESPACE}/${SECRET}..."
kubectl -n "$NAMESPACE" create secret tls "$SECRET" \
  --cert="$TMP/tls.crt" --key="$TMP/tls.key" \
  --dry-run=client -o yaml | kubectl apply -f -
