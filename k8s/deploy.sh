#!/usr/bin/env bash
set -euo pipefail

REGISTRY="jj123dev"
BACKEND_IMAGE="${REGISTRY}/omai-opencode:latest"
FRONTEND_IMAGE="${REGISTRY}/omai-app:latest"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Building backend image (${BACKEND_IMAGE})..."
docker build -t "$BACKEND_IMAGE" \
  --build-arg OPENCODE_HOST="omai-app.omai.svc.cluster.local" \
  --build-arg OPENCODE_SERVER_PORT="4096" \
  -f "$ROOT_DIR/Dockerfile.opencode" "$ROOT_DIR"

echo "==> Building frontend image (${FRONTEND_IMAGE})..."
docker build -t "$FRONTEND_IMAGE" \
  --build-arg VITE_OPENCODE_SERVER_HOST="" \
  --build-arg VITE_OPENCODE_SERVER_PORT="80" \
  --build-arg VITE_OPENCODE_SERVER_PROTOCOL="http" \
  -f "$ROOT_DIR/Dockerfile.app" "$ROOT_DIR"

echo "==> Pushing images to Docker Hub..."
docker push "$BACKEND_IMAGE"
docker push "$FRONTEND_IMAGE"

echo "==> Applying K8s manifests..."
kubectl apply -f "$SCRIPT_DIR/namespace.yml"
# PostgreSQL first: the backend exits immediately without OPENCODE_DATABASE_URL,
# so its rollout can never succeed before omai-postgres exists.
kubectl apply -f "$SCRIPT_DIR/pvc.yml"
kubectl apply -f "$SCRIPT_DIR/secret-instance.yml"
kubectl apply -f "$SCRIPT_DIR/secret-storage.yml"
# secret-cloudflare.yml is referenced by omai-storage/opencode deployments via
# secretKeyRef. Without it the pod stays in CreateContainerConfigError.
kubectl apply -f "$SCRIPT_DIR/secret-cloudflare.yml"
kubectl apply -f "$SCRIPT_DIR/postgres.yml"
kubectl apply -f "$SCRIPT_DIR/configmap-nginx.yml"
kubectl apply -f "$SCRIPT_DIR/configmap-opencode.yml"
kubectl apply -f "$SCRIPT_DIR/opencode-deployment.yml"
kubectl apply -f "$SCRIPT_DIR/app-deployment.yml"

echo "==> Waiting for deployments to be ready..."
kubectl -n omai rollout status deployment/omai-postgres --timeout=300s
kubectl -n omai rollout status deployment/omai-opencode --timeout=300s
kubectl -n omai rollout status deployment/omai-app --timeout=300s

echo "==> Checking LoadBalancer external IP..."
for i in {1..60}; do
  EXTERNAL_IP=$(kubectl -n omai get svc omai-app -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  if [ -n "$EXTERNAL_IP" ] && [ "$EXTERNAL_IP" != "" ]; then
    echo ""
    echo "==> Deployment complete!"
    echo "    Frontend: http://${EXTERNAL_IP}"
    echo "    Backend:  http://${EXTERNAL_IP}/global/health"
    exit 0
  fi
  echo -n "."
  sleep 5
done

echo ""
echo "==> Deployed! LoadBalancer IP not yet assigned. Check with:"
echo "    kubectl -n omai get svc omai-app"
