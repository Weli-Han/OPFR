#!/bin/sh
# OPFR runner for macOS/Linux: restart dispatcher until DONE or STOP; caffeinate/systemd-inhibit when present.
P="$1"; O="$P/.opfr"; D="$(cd "$(dirname "$0")/.." && pwd)/dispatcher/dispatcher.js"; n=0
wrap=""; command -v caffeinate >/dev/null && wrap="caffeinate -i"; command -v systemd-inhibit >/dev/null && wrap="systemd-inhibit --what=sleep"
while [ ! -f "$O/DONE" ] && [ ! -f "$O/STOP" ] && [ $n -lt 30 ]; do
  $wrap node "$D" "$P" >> "$O/dispatcher.out" 2>&1; n=$((n+1)); sleep 15
done
