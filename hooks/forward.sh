#!/bin/sh
# Forwards Claude Code hook JSON to the avatar. Never blocks and always exits 0.
# Sessions that the avatar starts itself (claude -p) set CLAUDE_AVATAR_CHILD and are skipped.
# X-Claude-Pid lets the avatar find the terminal of the session.
[ -n "$CLAUDE_AVATAR_CHILD" ] && exit 0
curl -s --max-time 1 -X POST -H "X-Claude-Pid: $PPID" --data-binary @- http://127.0.0.1:47823/event >/dev/null 2>&1 || true
exit 0
