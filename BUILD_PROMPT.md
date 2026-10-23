# Build prompt: Claude Code desktop avatar (macOS)

You are working in this folder. It contains a starter Electron app (`main.js`, `preload.js`, `index.html`, `package.json`, `README.md`). Read all files first. Then extend the app to meet the spec below. Read `CHARACTER.md` for the avatar design.

Work in small steps. After each step, run the app and test it with the `curl` commands in "Acceptance tests". Ask me before you change `~/.claude/settings.json`.

---

## 1. Goal

A small anime pixel-art maid lives on my macOS desktop. She watches my Claude Code sessions through hooks. When Claude needs me or finishes a task, she speaks a short sentence out loud and shows it in a speech bubble. I only open the terminal when she tells me to. I can click her to bring my terminal to the front.

## 2. Hard rules

- macOS only. Local use only. No cloud services. No telemetry.
- The HTTP server binds to `127.0.0.1` only.
- Hooks must never block or break Claude Code. Every hook call has a 1-second timeout and always exits with code 0.
- Never log or store transcript content. Read only what you need to speak, then drop it.
- Keep the code plain JavaScript (Node + Electron). No frontend framework. No build step for the renderer.

## 3. Architecture

```
Claude Code hooks ──stdin JSON──▶ hooks/forward.sh ──HTTP POST──▶ Electron main (127.0.0.1:47823/event)
                                                                     │
                                         ┌───────────────────────────┼────────────────────────┐
                                         ▼                           ▼                        ▼
                                  speech queue (`say`)        state machine            tray menu + config
                                                                     │
                                                                     ▼ IPC
                                                         renderer: sprite player + bubble
```

### 3.1 Hook forwarder

- Create `hooks/forward.sh`. It reads stdin and POSTs it to the server:
  `curl -s --max-time 1 -X POST --data-binary @- http://127.0.0.1:47823/event >/dev/null 2>&1 || true`
- Make it executable.

### 3.2 Hook installer

- Create `scripts/install-hooks.js` and `scripts/uninstall-hooks.js`. Add `npm run install-hooks` and `npm run uninstall-hooks`.
- The installer merges entries into `~/.claude/settings.json` for these events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`. Tool events use `"matcher": "*"`.
- Each entry runs the absolute path of `hooks/forward.sh`.
- Make a timestamped backup of `settings.json` first. Be idempotent: do not add duplicates. Keep all other existing hooks and settings untouched.
- The uninstaller removes only entries that point to `forward.sh`.

### 3.3 Server (main process)

- Accept `POST /event` with the hook JSON. Limit body size to 1 MB.
- Extract only: `hook_event_name`, `tool_name`, `message`, `session_id`, `cwd`, `transcript_path`.
- Derive `project` = basename of `cwd`.
- Pass the event to the state machine and the speech logic.

### 3.4 State machine

| Event | State | Speak? | What she says (default) |
|---|---|---|---|
| SessionStart | `greet` (2 s), then `idle` | optional (off by default) | "Ready in {project}." |
| UserPromptSubmit | `thinking` | no | — |
| PreToolUse | `working` | no | bubble only: "Using {tool}" |
| PostToolUse | `thinking` | no | — |
| Notification | `attention` | yes | The hook `message`, prefixed with the project: "{project}: {message}" |
| Stop | `done` (6 s), then `idle` | yes | "{project} is done. {summary}" |
| SessionEnd | `idle` | no | — |
| no event for 10 min | `sleeping` | no | — |
| while speaking | add `talking` overlay | — | — |

- Track state per `session_id`. The avatar shows the most urgent state across sessions. Priority: `attention` > `done` > `working` > `thinking` > `greet` > `idle` > `sleeping`.
- `attention` stays until the next event from that session, or until I click the avatar.

### 3.5 Stop summary

- Read the file at `transcript_path`. It is JSONL. First, inspect a real transcript on this machine to confirm the format. Do not guess it.
- Find the last assistant message. Join its text blocks. Ignore tool calls.
- Make a short summary without any API call: strip Markdown and code blocks, take the first sentence, cap it at 160 characters.
- If anything fails, say only "{project} is done."
- Optional, off by default: config flag `summarizeWithClaude`. It runs `claude -p` with a one-line summary prompt. Set an env var `CLAUDE_AVATAR_CHILD=1` on that process, and make `forward.sh` exit immediately when this var is set, so the child session does not trigger the avatar.

### 3.6 Speech

- Use the macOS `say` command through `child_process.spawn`. No shell string. Pass text as an argument.
- Keep a queue. One utterance at a time. Max 3 items in the queue; drop the oldest `done` items first. `attention` items go to the front.
- Do not repeat the same text for the same session within 20 seconds.
- **Do not speak when my terminal is the frontmost app.** Check the frontmost app with `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`. Compare it with `terminalApp` from config. If it matches, show the bubble but stay silent. If the check fails (permission denied), speak anyway and log one warning.
- Send `speaking:start` and `speaking:end` to the renderer for the `talking` overlay.

### 3.7 Click and drag

- Remove `-webkit-app-region: drag`. Implement drag manually: on `mousedown`, track movement; send window moves to main through IPC; main calls `win.setPosition`.
- If the pointer moved less than 4 px, treat it as a click.
- Click: stop speech, clear `attention`, and bring the terminal to the front with `open -a "{terminalApp}"`.
- Save the window position to config when a drag ends. Restore it on launch. If the saved position is off screen, use the bottom-right corner.

### 3.8 Tray menu

Use a small template image for the tray. Hide the Dock icon (`app.dock.hide()`). Menu items:

- Quiet mode (checkbox): bubble only, no speech.
- Speak when terminal is focused (checkbox).
- Voice: submenu. Build it from `say -v '?'`. Show English voices first.
- Size: 2×, 3×, 4×.
- Test speech.
- Open config file.
- Start at login (checkbox), with `app.setLoginItemSettings`.
- Quit.

### 3.9 Config

- File: `~/.claude-avatar/config.json`. Create it with defaults on first launch. Reload it when it changes.
- Defaults:

```json
{
  "port": 47823,
  "terminalApp": "Terminal",
  "voice": "Samantha",
  "rate": 190,
  "quietMode": false,
  "speakWhenTerminalFocused": false,
  "speakOnSessionStart": false,
  "summarizeWithClaude": false,
  "scale": 3,
  "position": null,
  "spritesDir": "sprites/default",
  "phrases": {
    "greet": "Ready in {project}.",
    "attention": "{project}: {message}",
    "done": "{project} is done. {summary}"
  }
}
```

## 4. Sprites

### 4.1 Format

- Folder per sprite pack: `sprites/<pack>/`.
- Each pack has `manifest.json` and one horizontal sprite sheet PNG per state:

```json
{
  "frameWidth": 64,
  "frameHeight": 64,
  "states": {
    "idle":      { "file": "idle.png",      "frames": 4, "fps": 4,  "loop": true },
    "thinking":  { "file": "thinking.png",  "frames": 4, "fps": 4,  "loop": true },
    "working":   { "file": "working.png",   "frames": 6, "fps": 10, "loop": true },
    "attention": { "file": "attention.png", "frames": 4, "fps": 8,  "loop": true },
    "done":      { "file": "done.png",      "frames": 6, "fps": 8,  "loop": false },
    "sleeping":  { "file": "sleeping.png",  "frames": 4, "fps": 2,  "loop": true },
    "greet":     { "file": "greet.png",     "frames": 4, "fps": 6,  "loop": false },
    "talking":   { "file": "talking.png",   "frames": 2, "fps": 8,  "loop": true, "overlay": true }
  }
}
```

- `talking` is an overlay layer (mouth frames) drawn on top of the current state, at the same frame size.
- If a state file is missing, fall back to `idle`.

### 4.2 Rendering

- Draw on a `<canvas>`. Use integer scaling only (`scale` from config). Set `imageSmoothingEnabled = false` and CSS `image-rendering: pixelated`.
- Resize the window to fit `frameWidth × scale` plus space for the bubble.
- The bubble uses a pixel-style look: square corners, 2 px dark outline, small tail toward the character. Max width 260 px. Wrap text. Keep it visible for 8 seconds or until speech ends, whichever is later.
- Respect `prefers-reduced-motion`: show frame 0 only.

### 4.3 Placeholder pack (build this now)

I do not have final art yet. Create `scripts/make-placeholder-sprites.js` that generates the `sprites/default` pack in code, as pixel arrays written to PNG (use `pngjs`). Draw the original character from `CHARACTER.md` in a simple, readable form at 64×64, with the palette from that file. Each state needs visible differences (pose, eyes, effects such as `?`, `!`, sparkles, `z`). It does not need to be perfect. I will replace it with real art later.

## 5. Acceptance tests

Run these with the app open:

```bash
P=http://127.0.0.1:47823/event
curl -X POST --data '{"hook_event_name":"SessionStart","session_id":"a","cwd":"/tmp/demo"}' $P
curl -X POST --data '{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"a","cwd":"/tmp/demo"}' $P
curl -X POST --data '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash","session_id":"a","cwd":"/tmp/demo"}' $P
curl -X POST --data '{"hook_event_name":"Stop","session_id":"a","cwd":"/tmp/demo","transcript_path":"/nonexistent"}' $P
```

Check that:

1. Each event changes the sprite state.
2. Notification speaks "demo: Claude needs your permission to use Bash".
3. Stop with a bad path speaks "demo is done." and does not crash.
4. With the terminal app frontmost, nothing is spoken but the bubble shows.
5. Quiet mode stops all speech.
6. Click opens the terminal. Drag moves the avatar. Position survives a restart.
7. With the app closed, a real Claude Code session still works with no delay or error.

## 6. Deliverables

- Working app: `npm start`.
- `npm run install-hooks`, `npm run uninstall-hooks`, `npm run sprites`.
- Updated `README.md`: setup, config, how to add a sprite pack, how to grant the Automation permission for the frontmost-app check.
