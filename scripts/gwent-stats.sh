#!/usr/bin/env bash

APP=${GWENT_APP:-gwent-server}
DAYS=${DAYS:-1}

LOGFILE=$(pm2 jlist 2>/dev/null \
  | node -e "
      const p = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      const a = p.find(x => x.name === '$APP');
      process.stdout.write(a ? a.pm2_env.pm_out_log_path : '');
    " 2>/dev/null)

if [ -z "$LOGFILE" ] || [ ! -f "$LOGFILE" ]; then
  echo "Log not found for pm2 app '$APP'. Set GWENT_APP=<name> to override."
  exit 1
fi

if [ "$DAYS" = "all" ]; then
  LOG=$(cat "$LOGFILE")
  LABEL="all time"
elif [ "$DAYS" = "1" ]; then
  LOG=$(grep "$(date +%Y-%m-%d)" "$LOGFILE") || LOG=""
  LABEL="today $(date +%Y-%m-%d)"
else
  PATTERN=$(for i in $(seq 0 $((DAYS - 1))); do date -d "$i days ago" +%Y-%m-%d; done | paste -sd'|')
  LOG=$(grep -E "$PATTERN" "$LOGFILE") || LOG=""
  LABEL="last $DAYS days"
fi

count() { printf '%s' "$LOG" | grep -c "$1" 2>/dev/null || echo 0; }

echo "=== Gwent stats — $LABEL ==="
printf "  SP started:    %s\n" "$(count 'sp-game-started')"
printf "  SP finished:   %s\n" "$(count 'sp-game-finished')"
printf "  MP rooms:      %s\n" "$(count 'room-created')"
printf "  MP games:      %s\n" "$(count '\] game-started')"
printf "  MP ended:      %s\n" "$(count 'game-ended')"
printf "  QM searches:   %s\n" "$(count 'mode-qm')"
printf "  QM games:      %s\n" "$(count 'mode=quickmatch')"
