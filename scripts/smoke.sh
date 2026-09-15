#!/usr/bin/env bash
# End-to-end smoke test against the DEPLOYED scheduler.
#
#   bash scripts/smoke.sh
#
# Registers a queue against a throwaway receiver, enqueues a job, and waits for
# the delivery to actually arrive. Unlike the integration suite, this exercises
# the real container, the real Postgres and the real network — which is where
# the things that pass in a test and fail in production live.
#
# Cleans up after itself, including on failure.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUEUE="smoke.$(date +%s)"
RECEIVER="scheduler-smoke-receiver-$$"
BASE="http://127.0.0.1:80"
HOSTHDR="Host: scheduler.app"

TOKEN="$(grep '^SCHEDULER_TOKENS' "$DIR/.env" | sed 's/^SCHEDULER_TOKENS=//' \
         | tr ',' '\n' | grep '^ops:' | cut -d: -f2)"
[[ -n "$TOKEN" ]] || { echo "fail: no 'ops' token in $DIR/.env" >&2; exit 1; }

cleanup() {
    curl -s -X DELETE "$BASE/v1/queues/$QUEUE" -H "$HOSTHDR" \
         -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    docker rm -f "$RECEIVER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

api() {
    local method="$1" path="$2" body="${3:-}"
    if [[ -n "$body" ]]; then
        curl -sS -X "$method" "$BASE$path" -H "$HOSTHDR" \
             -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body"
    else
        curl -sS -X "$method" "$BASE$path" -H "$HOSTHDR" -H "authorization: Bearer $TOKEN"
    fi
}

echo ":: readiness"
api GET /readyz | grep -q '"status":"ok"' || { echo "fail: not ready" >&2; exit 1; }
echo "ok   the scheduler is ready"

echo ":: starting a throwaway receiver on frontend"
# The receiver must answer 200 to ANY path, and that is not incidental. A stock
# nginx 404s /hook, the scheduler correctly treats that as a failed delivery, and
# an earlier version of this script called that a pass because it only checked
# that the request had ARRIVED. Arriving and being accepted are different
# outcomes, and only one of them means the system works.
docker run -d --rm --name "$RECEIVER" --network frontend \
    nginx:1.27-alpine sh -c \
    "printf 'server { listen 80; location / { return 200 \"ok\"; } }' \
     > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'" >/dev/null
for _ in $(seq 1 20); do
    docker exec "$RECEIVER" wget -q -O- http://127.0.0.1/ >/dev/null 2>&1 && break
    sleep 0.5
done
echo "ok   receiver up"

echo ":: creating queue $QUEUE"
api POST /v1/queues "{\"name\":\"$QUEUE\",\"target\":\"http://$RECEIVER/hook\",
  \"description\":\"smoke test\",\"retryLimit\":0}" >/dev/null
echo "ok   queue created"

echo ":: enqueueing a job"
JOB="$(api POST /v1/jobs "{\"queue\":\"$QUEUE\",\"data\":{\"smoke\":true},
  \"context\":{\"cause\":\"smoke.sh\"}}")"
JOB_ID="$(echo "$JOB" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
[[ -n "$JOB_ID" ]] || { echo "fail: no job id in: $JOB" >&2; exit 1; }
echo "ok   enqueued $JOB_ID"

echo ":: waiting for delivery"
# BOTH assertions. The receiver's log proves the request arrived; the scheduler's
# proves it was ACCEPTED. Checking only the first passes on a 404.
for _ in $(seq 1 60); do
    arrived=$(docker logs "$RECEIVER" 2>&1 | grep -c 'POST /hook' || true)
    accepted=$(docker logs pgboss-scheduler 2>&1 \
               | grep "$JOB_ID" | grep -c '"msg":"delivered"' || true)
    if [[ "$arrived" -gt 0 && "$accepted" -gt 0 ]]; then
        echo "ok   delivered and accepted — the full path works"
        echo
        echo "     scheduler -> $RECEIVER over frontend"
        docker logs pgboss-scheduler 2>&1 | grep "$JOB_ID" | tail -1
        exit 0
    fi
    sleep 1
done

echo "fail: no accepted delivery within 60s." >&2
echo "      receiver saw $(docker logs "$RECEIVER" 2>&1 | grep -c 'POST /hook' || true) request(s)." >&2
echo "      scheduler said:" >&2
docker logs pgboss-scheduler 2>&1 | grep "$JOB_ID" | tail -5 >&2
exit 1
