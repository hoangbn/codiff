#!/bin/sh

completion_path=$1
shift

exec 3<&0
"$@" <&3 &
worker_pid=$!
exec 3<&-

stop_worker() {
  kill -TERM "$worker_pid" 2>/dev/null
  wait "$worker_pid"
}
trap stop_worker TERM INT HUP

wait "$worker_pid"
exit_code=$?
if ! printf '{"code":%s}\n' "$exit_code" > "$completion_path"; then
  exit 1
fi
exit "$exit_code"
