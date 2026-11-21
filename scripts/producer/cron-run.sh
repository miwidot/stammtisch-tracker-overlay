#!/usr/bin/env bash
# Cron wrapper for the catalog producer, with Discord alerts.
#
#   cron-run.sh run         fetch tags from origin, build overlay + catalogs (npm run build:catalogs),
#                           alert on failure. A build whose overlay version is LOWER than the live
#                           release's is refused before `current` flips (exit code 3 of the build)
#                           and alerts separately; the last good release stays live.
#   cron-run.sh check-age   alert when the live catalog release is older than STALE_HOURS
#
# Example crontab (as the user that owns the checkout):
#   17 */12 * * * /path/to/overlay/scripts/producer/cron-run.sh run
#   47 *    * * * /path/to/overlay/scripts/producer/cron-run.sh check-age
#
# Environment (all optional unless noted):
#   CATALOG_OUT_DIR              output root, default $HOME/tracker-data. TARKOV_DATA_DIR = <it>/current
#   PRODUCER_KEEP_RELEASES       releases to keep (producer prunes inside <out>/releases only), default 4
#   PRODUCER_TOOLS_DIR           tracker checkouts, default ~/.cache/stammtisch-overlay-producer
#   PRODUCER_TOOLS_KEEP          set (e.g. 2) to also prune superseded tracker checkouts after a
#                                successful run; unset = never delete checkouts (default)
#   TRACKER_REPO                 git URL of the tracker fork, passed through to the producer
#   PRODUCER_LOG                 log file, default $HOME/producer.log (rotated by rename at 5 MB)
#   PRODUCER_STATE_DIR           alert throttle state, default = directory of the log
#   STALE_HOURS                  default 30 (two missed 12 h runs)
#   ALERT_REPEAT_HOURS           minimum gap between repeated stale alerts, default 6
#   DISCORD_SYSTEM_LOG_WEBHOOK   alert target. Never logged or echoed. If unset, ENV_FILE is
#                                scanned for exactly that one variable (the file is not sourced).
#   ENV_FILE                     e.g. the main site's .env
#   PRODUCER_ALLOW_VERSION_REGRESSION  set to 1 for one deliberate downgrade (passed to the build)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="${CATALOG_OUT_DIR:-$HOME/tracker-data}"
KEEP_RELEASES="${PRODUCER_KEEP_RELEASES:-4}"
LOG="${PRODUCER_LOG:-$HOME/producer.log}"
STATE_DIR="${PRODUCER_STATE_DIR:-$(dirname "$LOG")}"
STALE_HOURS="${STALE_HOURS:-30}"
ALERT_REPEAT_HOURS="${ALERT_REPEAT_HOURS:-6}"
MAX_LOG_BYTES=5242880

log() { printf '%s %s\n' "$(date -Is 2>/dev/null || date)" "$*" >>"$LOG"; }

require_positive_int() {
  case "$2" in '' | *[!0-9]* | 0) echo "cron-run: $1 must be a positive integer" >&2; exit 2 ;; esac
}
require_positive_int PRODUCER_KEEP_RELEASES "$KEEP_RELEASES"
require_positive_int STALE_HOURS "$STALE_HOURS"
require_positive_int ALERT_REPEAT_HOURS "$ALERT_REPEAT_HOURS"
if [ -z "$OUT_DIR" ] || [ "$OUT_DIR" = "/" ]; then
  echo "cron-run: refusing empty or root CATALOG_OUT_DIR" >&2
  exit 2
fi
mkdir -p "$(dirname "$LOG")" "$STATE_DIR"

# Read the webhook from the environment, or extract that single variable from ENV_FILE.
load_webhook() {
  [ -n "${DISCORD_SYSTEM_LOG_WEBHOOK:-}" ] && return 0
  [ -n "${ENV_FILE:-}" ] && [ -r "$ENV_FILE" ] || return 1
  local line
  line="$(grep -E '^(export[[:space:]]+)?DISCORD_SYSTEM_LOG_WEBHOOK=' "$ENV_FILE" | tail -n 1)"
  line="${line#export }"
  line="${line#DISCORD_SYSTEM_LOG_WEBHOOK=}"
  line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  [ -n "$line" ] || return 1
  DISCORD_SYSTEM_LOG_WEBHOOK="$line"
}

# Posts a plain message. The URL goes to curl through its config on stdin, so it never appears in
# the process list, and curl's own output is discarded so it can never reach the log.
post_alert() {
  if ! load_webhook; then
    log "alert not sent (no webhook configured): $1"
    return 1
  fi
  local text json code
  text="$(printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | cut -c1-1500)"
  json="{\"content\":\"${text}\"}"
  code="$(printf 'url = "%s"\n' "$DISCORD_SYSTEM_LOG_WEBHOOK" |
    curl -s -m 20 -K - -H 'Content-Type: application/json' --data-binary "$json" \
      -o /dev/null -w '%{http_code}' 2>/dev/null)"
  case "$code" in
    2??) return 0 ;;
    *) log "alert delivery failed (HTTP ${code:-none})"; return 1 ;;
  esac
}

rotate_log() {
  local size
  size="$(wc -c <"$LOG" 2>/dev/null | tr -d ' ')"
  # Rename only; the previous rotation is overwritten by mv, nothing is deleted.
  if [ "${size:-0}" -gt "$MAX_LOG_BYTES" ]; then mv -f "$LOG" "$LOG.1"; fi
}

# The overlay version is derived from the release tags, so stale tags produce a wrong (lower)
# version. Fetch them from our own origin first. Never fatal: a failed fetch is logged and
# alerted, and the version guard still protects the live release.
fetch_tags() {
  local output
  if output="$(git -C "$REPO_DIR" fetch --tags origin 2>&1)"; then
    log "tags fetched from origin"
    return 0
  fi
  log "tag fetch FAILED: $(printf '%s' "$output" | tail -n 3 | tr '\n' ' ')"
  post_alert "$(hostname -s 2>/dev/null) catalog producer could not fetch release tags from origin; building with the local tags, the version guard stays active. See $LOG"
  return 0
}

cmd_run() {
  rotate_log
  local start
  start="$(date -Is 2>/dev/null || date)"
  cd "$REPO_DIR" || { post_alert "catalog producer FAILED ($start): cannot enter $REPO_DIR"; exit 1; }
  fetch_tags
  log "run start (keep=$KEEP_RELEASES)"
  npm run build:catalogs -- --out "$OUT_DIR" --keep "$KEEP_RELEASES" >>"$LOG" 2>&1
  local status=$?
  if [ "$status" -eq 3 ]; then
    # Exit code 3 = version regression refused by the pre-flip guard in build-catalogs.ts.
    log "run REFUSED: overlay version regressed, previous release stays live"
    post_alert "$(hostname -s 2>/dev/null) catalog build REFUSED ($start): the overlay version went DOWN compared to the live release (release tags missing or wrong?). Nothing was published, the last good release stays live. See $LOG"
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    log "run FAILED"
    post_alert "$(hostname -s 2>/dev/null) catalog producer FAILED ($start). The last good release stays live. See $LOG"
    exit 1
  fi
  log "run ok"
  if [ -n "${PRODUCER_TOOLS_KEEP:-}" ]; then
    require_positive_int PRODUCER_TOOLS_KEEP "$PRODUCER_TOOLS_KEEP"
    local tools="${PRODUCER_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/stammtisch-overlay-producer}"
    if ! npx tsx scripts/producer/prune-tools.ts --tools-dir "$tools" --keep "$PRODUCER_TOOLS_KEEP" >>"$LOG" 2>&1; then
      log "tools pruning failed (non-fatal)"
    fi
  fi
}

# Epoch seconds of createdAt from the live manifest, empty when missing or malformed.
manifest_epoch() {
  local file="$OUT_DIR/current/producer-manifest.json"
  [ -r "$file" ] || return 1
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const t = Date.parse(m.createdAt);
    if (!Number.isFinite(t)) process.exit(1);
    console.log(Math.floor(t / 1000));
  ' "$file" 2>/dev/null
}

cmd_check_age() {
  local epoch now age_h reason
  now="$(date +%s)"
  if epoch="$(manifest_epoch)" && [ -n "$epoch" ]; then
    age_h=$(( (now - epoch) / 3600 ))
    if [ "$age_h" -le "$STALE_HOURS" ]; then
      return 0
    fi
    reason="the live catalog release is ${age_h} h old (limit ${STALE_HOURS} h)"
  else
    reason="no readable producer-manifest.json under $OUT_DIR/current"
  fi
  local marker="$STATE_DIR/.catalog-stale-alert"
  # Repeat at most every ALERT_REPEAT_HOURS while the problem persists.
  if [ -e "$marker" ] && [ -z "$(find "$marker" -mmin +$(( ALERT_REPEAT_HOURS * 60 )) 2>/dev/null)" ]; then
    return 0
  fi
  log "stale: $reason"
  if post_alert "$(hostname -s 2>/dev/null) catalog data is stale: $reason"; then
    : >"$marker"
  fi
  return 1
}

case "${1:-run}" in
  run) cmd_run ;;
  check-age) cmd_check_age ;;
  *) echo "usage: cron-run.sh run|check-age" >&2; exit 2 ;;
esac
