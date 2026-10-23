# AI Assistant: Fern, a desktop avatar for Claude Code

<p align="center"><img src="docs/fern.png" alt="Fern, pixel-art avatar" width="192"></p>

A small pixel-art Fern lives on your macOS desktop and works as your personal assistant on top of Claude Code:

- **Watches every Claude Code session** through hooks. She says when a session needs you or is done, and shows a small avatar for each open session.
- **Talks with you** by voice ("Fern, …", with voice identification) or in a terminal-style panel (Cmd+Shift+K).
- **Does work for you.** She has full access to the Mac, starts background Claude jobs for coding work, and asks for your OK before critical actions (push, delete, post).
- **Runs locally.** whisper.cpp for speech-to-text, Kokoro for a neural voice, sherpa-onnx for voice ID. The server listens on `127.0.0.1` only. The only cloud service is the `claude` CLI that you already use.

![Fern's states: idle, thinking, working, attention, done, sleeping, greet](docs/states.png)

macOS only. Node.js and Electron, plain JavaScript, no build step.

## 1. Setup

```bash
git clone https://github.com/Scofez/AI-Assistant.git
cd AI-Assistant
npm install
npm run setup
npm start
```

`npm install` installs only the npm packages (Electron, sherpa-onnx-node, pngjs). `npm run setup` does the rest and asks before each change:

1. Checks macOS, Node.js (18 or newer), and the npm packages.
2. Checks that the `claude` CLI is installed. Log in with `claude` once: Fern uses that account.
3. Installs whisper.cpp with Homebrew.
4. Downloads the 3 models to `~/.claude-avatar/models` (about 575 MB): whisper, the speaker model, and Kokoro.
5. Turns on the Kokoro voice.
6. Installs the Claude Code hooks (with a backup of `~/.claude/settings.json`).
7. Adds an optional `fern` / `fern stop` / `fern status` command to `~/.zshrc`.

Run it again at any time. Parts that are ready are skipped. `npm run setup -- --yes` answers yes to every question.

After the setup, you still need to do these steps yourself: set up your voice (tray > Set up my voice…), and allow Microphone and Automation when macOS asks.

Fern appears in the bottom-right corner. The tray icon (a staff ring) holds the menu. There is no Dock icon.

## 2. Connect Claude Code

```bash
npm run install-hooks     # adds hooks to ~/.claude/settings.json (backup first, no duplicates)
npm run uninstall-hooks   # removes only the avatar hooks
```

Every hook runs `hooks/forward.sh`. It posts the hook JSON with a 1 second timeout and always exits 0. When the avatar is closed, Claude Code is not affected. Restart Claude Code after you install, and check with `/hooks`.

`forward.sh` uses port 47823. If you change `port` in the config, change it in `forward.sh` too.

## 3. Use it

| Action | Result |
|---|---|
| Click Fern | Stops speech, clears `attention`, brings the terminal to the front. |
| Drag Fern | Moves her. The position is saved and restored on launch. |
| 🎙 button | Mutes or unmutes the microphone (the always-on listening for "Fern"). A muted mic has a strike line. |
| 🔊 button | Mutes or unmutes Fern's voice (quiet mode). Muted shows 🔇. The buttons stay visible while one is muted. |

### Fern is the main session

Fern is not one of your Claude Code sessions. She stands above them. Her `claude -p` chat gets tools from a small MCP server inside the app (`http://127.0.0.1:47823/mcp`, random token per launch, stored in `~/.claude-avatar/mcp.json` with owner-only access):

| Tool | What it does |
|---|---|
| `list_sessions` | Live sessions from the hooks: project, state, what it waits for, last summary. Also Fern's jobs. |
| `read_session_output` | Last answer of one session, read from its transcript on demand. |
| `find_project` | Finds project folders by name, in known sessions and `projectRoots`. |
| `start_job` | Starts a background `claude -p` job in a project folder inside your home folder. Max 3 at a time. |
| `get_job`, `cancel_job` | Job status and result, or stop it. |

When a job ends, Fern tells you in the bubble and the panel, and speaks it. Her chat uses only these tools (`--strict-mcp-config`, `--allowedTools mcp__fern`). Your other MCP servers are not loaded in her chat.

### Full access with confirmation of critical actions

Fern has full access to the Mac: Bash, files, the web, apps, and your MCP servers. Coding work goes to jobs (Claude sessions). Fern and every job run with `--permission-mode manual` and `--permission-prompt-tool mcp__fern__approve`. So each action that needs permission goes to the app first. `lib/guard.js` decides with fixed rules:

- **Critical, needs your OK:** `git push`, history rewrites, `gh` changes (comments, PRs, issues), `rm`/`mv`/`-delete`, `sudo`, `curl` that sends data, `ssh`/`scp`/`rsync`, cloud CLIs, installs, process and system changes, `osascript`, inline code (`python -c`, `| sh`), reads or writes of secrets (`~/.ssh`, `.env`, keys), writes to shell profiles, Claude settings, or system folders, MCP tools that create, send, post, comment, or delete, and messages to other Claude sessions. A job may not write outside its project.
- **Everything else** runs without asking.

A critical action shows **Allow / Deny** in the bubble and in the panel (keys `y` / `n`, or `/allow`, `/deny`), and Fern says it aloud. Voice cannot answer, so a recording cannot approve anything. With no answer in `approvalTimeoutSeconds` (300), the action is denied. The log shows each question and answer (`[approval]`).

Fern works in the empty folder `~/.claude-avatar/workspace`, so every file outside it goes through the check.

The rules are best effort. A command can hide what it does. Read the command in the confirmation before you click Allow.

Your global `defaultMode: "auto"` does not apply to Fern or jobs: they always set `manual`. Do not set `jobPermissionMode` to `"bypassPermissions"`: that turns off all checks for jobs.

### Claude Code updates

When Fern starts and every 6 hours, she compares `claude --version` with the newest version on the npm registry (`@anthropic-ai/claude-code`). When a newer one exists, she tells you once in the bubble and the panel, and the status line shows it. Type `/update` in the panel: she runs `claude update` and shows its output. After that, she lists the open sessions that still run the older version, so you can restart them. `/version` shows the installed and newest versions and the version of each open session. Turn the check off with `"checkClaudeUpdates": false`. The check sends no data about you; it only downloads the version number.

### Session avatars

Left of Fern, a small avatar stands for each open Claude Code session. The box above it shows the session title (your `/rename` name, or Claude's automatic title) and the folder that the session started in. The box border shows the state: orange needs you, blue is working, mint is done.

- **Your prompts** to a session do not show over Fern. A small envelope drops into that session's avatar instead, as if the prompt was delivered. Notices from sessions ("… needs you", "Claude finished in …") still show in Fern's bubble.
- **Subagents** of a session show as clones in that session's colors, with their number ("Agent #1").
- **Fern's jobs** show as small Fern clones with their number ("Fern #1").
- **Fern's own subagents** (her Agent or Task tool calls) show as Fern clones next to her, with their description ("Fern agent #1" when there is none). A clone goes away when its agent ends or when Fern's `claude -p` process stops. A click shows Fern's chat in the panel.
- **Click a session or its agent:** its Terminal tab comes to the front. When the session is closed, a new Terminal window opens with `claude --resume <id>` in its folder. The first click asks for the Automation permission for Terminal. Terminal and iTerm2 are supported.
- **Click a Fern clone:** the panel shows the job.

Fern finds the sessions that already run when she starts: Claude Code keeps a registry of its running interactive sessions in `~/.claude/sessions/<pid>.json` (session id, folder, version, busy or idle). Fern reads it at start and every 30 s, so a session shows before it sends a hook. She reads only the `<pid>.json` files, never the `.key` files next to them. `hooks/forward.sh` also sends the hook's parent process id, so the app can find the session's terminal. When a `/clear` or `/resume` inside a session changes its id, the old avatar goes away. At most 8 avatars show; the rest are counted in a "+N more" box. The empty parts of the window let mouse clicks through to the desktop.

Background subagents end with the `SubagentStop` hook. Run `npm run install-hooks` again after an update to add it.

### Two ways to talk to Fern

1. **Voice:** say "Fern, …" (below).
2. **Keyboard:** press **Cmd+Shift+K**. A panel opens that looks like Claude Code: your prompt on a grey band after `>`, Fern's replies and tool calls after `⏺`, tool results after `⎿`, all shown live while she works. Replies show Markdown (bold, code, lists, code blocks, tables as aligned text). The output of `/usage` and `/context` gets bars, like in the interactive terminal: each limit ("Current session: 60% used") as a bar that turns amber from 50% and orange from 80%, each "contributing" line as a small bar, and a bar column for tables with percentages. Up and Down keys show your earlier lines. Under the input, a status line shows Fern's model, effort, chat, and the Claude Code version. Typed replies are not spoken unless `speakTypedReplies` is `true`.

   - **Commands with autocomplete:** type `/` and a menu shows the commands that match. ↑ ↓ to choose, Tab to complete, Enter to run, Esc to close. There are 3 kinds:

     | Kind | Commands | What happens |
     |---|---|---|
     | Fern | `/help`, `/resume`, `/clear` (`/new`), `/model [name]`, `/effort [level]`, `/sessions`, `/jobs`, `/cancel <id>`, `/allow`, `/deny`, `/version`, `/update` | Fern runs them herself. `/model` and `/effort` change only Fern (`fernModel`, `fernEffort` in the config), never your other Claude sessions. `/model default` goes back to the default. |
     | Claude | `/usage`, `/context`, `/compact`, `/mcp`, `/insights`, `/recap`, `/list-agents` | Sent to Fern's Claude session. Most run locally at no cost. `/mcp` runs only as a list. |
     | Skills | every skill that Claude reports, for example `/code-review` | Sent to Fern as a prompt, so the skill runs in her chat. |

     The list comes from Claude itself (the `init` message of Fern's `claude -p` runs), so new commands and skills show by themselves. Claude commands that change your global settings or need the interactive terminal (for example `/config`, `/theme`, `/login`) are not run; Fern says so.
   - **`/sessions`** shows a table of the Claude Code sessions in your terminals and Fern's running jobs: id, title, state, Claude version, folder.

   - **`/resume`:** lists your earlier chats with Fern, newest first, like Claude Code's `/resume`. Each row shows the first question, the number of messages, and the age. Use ↑ ↓ and Enter, or click. Fern then continues that chat, and her tab shows its messages (up to the last 200 lines). The chats are the Claude Code sessions in `~/.claude/projects/-Users-<you>--claude-avatar-workspace/`. Chats from before Fern moved to her workspace folder are not listed, because `--resume` finds only sessions of the current folder. Typed replies are not spoken unless `speakTypedReplies` is `true`.

   - **Window buttons:** the usual macOS buttons. Red (or Esc, or Cmd+Shift+K) hides the panel and keeps its tabs. Yellow minimizes. Green zooms the panel to fill the screen (it stays in the same Space). The panel is a normal window: other windows, for example a Terminal tab that you open from a session avatar, can go above it. A confirmation brings it to the top. Fern always stays on top of it.
   - **Tabs:** "Fern · main session" is your chat with Fern. Each job that Fern starts gets its own tab ("Fern #1 · project"). It logs the job live, like a Claude Code session: `⏺` for Claude's text and tool calls, `⎿` for tool results. The dot shows the state: blue running, mint done, orange failed or waiting for your OK. A bold tab has new lines. Cmd+1 to Cmd+9 switch tabs. A tab of a finished job can be closed with ×.
   - A confirmation from a job shows in that job's tab. A click on a Fern clone next to the avatar opens its tab.
   - Each tab keeps its last 1500 lines in memory only. Tool results show their first 8 lines.

Voice and keyboard use the same Fern chat. The panel shows the full conversation and the tools that Fern uses. History is in memory only.

### Hands-free: say "Fern"

When *Listen for "Fern"* is on (tray, default on), the mic stays open. A small mint square next to Fern shows it; it turns orange while she hears a phrase.

1. Tray > **Set up my voice…** Read the 3 sentences that Fern shows, one at a time.
2. Say **"Fern, …"** and your question. Or say **"Fern"**, wait for "Yes?", then ask within 8 seconds.

For each phrase, Fern checks the voice against your voiceprint, and whisper transcribes it on your Mac. A phrase with "Fern" anywhere goes to a small fast model (`classifierModel`) that decides if it is a request to her. Requests from your voice go to Fern. Requests from other voices get a polite refusal. Other phrases are dropped. Nothing is saved.

Tune `voiceMatchThreshold` (default `0.6`, range -1 to 1). Higher is stricter. If Fern ignores you, lower it to `0.5`. If she reacts to others, raise it.

**Warning:** voice identification is not strong security. A recording or a similar voice can pass it. Do not depend on it to protect anything.

### Fern as assistant (`claude -p`)

Voice and the panel use a separate `claude -p` chat in `assistantCwd`. The thread is kept with `--resume` until you pick *New chat with Fern* in the tray, or restart the app. Critical actions ask you for confirmation first (see *Full access with confirmation of critical actions*). The child process has `CLAUDE_AVATAR_CHILD=1`, so its own hooks do not trigger the avatar.

## 4. Speech-to-text and voice ID models

```bash
brew install whisper-cpp
mkdir -p ~/.claude-avatar/models
curl -L -o ~/.claude-avatar/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
curl -L -o ~/.claude-avatar/models/wespeaker_en_voxceleb_resnet34.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx
```

`ggml-base.en.bin` is English only (about 150 MB). For other languages, use `ggml-base.bin` and set `whisperModel` and `whisperLanguage: "auto"`. The speaker model (about 26 MB) runs through the `sherpa-onnx-node` package. Each phrase is saved to a private temp folder only while whisper runs, then deleted.

The first time Fern listens, macOS asks for **Microphone** access.

### Neural voice (Kokoro)

Fern can speak with Kokoro, a local neural voice model (about 400 MB, runs offline through `sherpa-onnx-node`):

```bash
cd ~/.claude-avatar/models
curl -L -O https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2
tar xjf kokoro-multi-lang-v1_0.tar.bz2 && rm kokoro-multi-lang-v1_0.tar.bz2
```

Choose a voice in tray > Voice > Kokoro. The `jf_*` voices read English with a Japanese accent, which is the closest to an anime voice. Kokoro needs about 2 seconds to prepare each sentence. If Kokoro fails, Fern uses `say` and logs one warning.

## 5. Config

File: `~/.claude-avatar/config.json`. Created on first launch. Reloaded when it changes.

| Key | Default | Meaning |
|---|---|---|
| `port` | `47823` | Local server port. |
| `terminalApp` | `"Terminal"` | App name for the focus check and for clicks on Fern and on session avatars. `"Terminal"` or `"iTerm2"`. |
| `voice`, `rate` | `"Samantha"`, `190` | `say` voice and words per minute. |
| `quietMode` | `false` | Bubble only, no speech. The 🔊 button changes it. |
| `speakWhenTerminalFocused` | `false` | Speak even when the terminal is the front app. |
| `speakOnSessionStart` | `false` | Say the greet phrase on SessionStart. |
| `summarizeWithClaude` | `false` | Make the Stop summary with `claude -p` instead of the first sentence. |
| `scale` | `3` | Integer pixel scale (2, 3, 4). |
| `position` | `null` | Saved window position. |
| `spritesDir` | `"sprites/default"` | Sprite pack folder, relative to the app. |
| `phrases` | see file | Templates. Fields: `{project}`, `{message}`, `{summary}`. |
| `assistantCwd` | `~/.claude-avatar/workspace` | Fern's empty working folder. |
| `claudePath` | `"claude"` | Path to the Claude CLI. |
| `whisperPath`, `whisperModel`, `whisperLanguage` | `"whisper-cli"`, `~/.claude-avatar/models/ggml-base.en.bin`, `"en"` | whisper.cpp settings. |
| `listenForWakeWord` | `true` | Always-on mic for "Fern". |
| `wakeWords` | `["fern", "firn", "fearn", "ferne"]` | Words that wake her. Extra spellings catch whisper mistakes. |
| `speakerModel` | `~/.claude-avatar/models/wespeaker_en_voxceleb_resnet34.onnx` | Speaker embedding model. |
| `voiceMatchThreshold` | `0.6` | Minimum voice similarity. |
| `voiceFeedback` | `true` | Show what Fern heard when you did not say her name. |
| `ttsEngine` | `"say"` | `"say"` (macOS voices) or `"kokoro"` (neural). |
| `kokoroVoice`, `kokoroSpeed` | `"jf_alpha"`, `1` | Kokoro speaker and speed (higher is faster). |
| `kokoroDir` | `~/.claude-avatar/models/kokoro-multi-lang-v1_0` | Kokoro model folder. |
| `phraseEndSilenceMs` | `1500` | Silence that ends a spoken phrase. Raise it if you pause often. |
| `classifierModel` | `"haiku"` | Model that decides if a phrase with "Fern" is a request. |
| `approvalTimeoutSeconds` | `300` | Time to answer a confirmation. Then the action is denied. |
| `panelShortcut` | `"CommandOrControl+Shift+K"` | Global shortcut for the panel (Electron accelerator). |
| `speakTypedReplies` | `false` | Speak replies to typed questions. |
| `projectRoots` | `["~/personal", "~/work"]` | Folders that `find_project` searches (one level). |
| `jobPermissionMode` | `""` | `--permission-mode` for jobs. Empty means `manual` with the app's confirmation check. |
| `jobTimeoutMinutes` | `30` | A job is stopped after this time. |
| `fernModel`, `fernEffort` | `""` | Fern's model and effort. Empty means the Claude default. Set them with `/model` and `/effort`. |
| `checkClaudeUpdates` | `true` | Check for a newer Claude Code every 6 hours. |

## 6. Permissions

- **Automation (System Events):** used to check if the terminal is the front app. macOS asks the first time. If you missed the prompt, open System Settings > Privacy & Security > Automation, find Electron, and turn on System Events. If the check fails, Fern speaks anyway and logs one warning.
- **Microphone:** for listening to "Fern".
- **Automation (Terminal):** to bring a session's tab to the front, or to open a session.

## 7. Add a sprite pack

1. Make a folder `sprites/<pack>/`.
2. Add one horizontal PNG strip per state, all frames the same size.
3. Add `manifest.json`:

```json
{
  "frameWidth": 64,
  "frameHeight": 64,
  "states": {
    "idle":    { "file": "idle.png", "frames": 4, "fps": 4, "loop": true },
    "done":    { "file": "done.png", "frames": 6, "fps": 8, "loop": false, "mouthOffsets": [[0,0],[0,1],[0,2],[0,0],[0,0],[0,0]] },
    "talking": { "file": "talking.png", "frames": 2, "fps": 8, "loop": true, "overlay": true }
  }
}
```

States: `idle`, `thinking`, `working`, `attention`, `done`, `sleeping`, `greet`, `talking`. A missing state falls back to `idle`. `talking` is a mouth overlay drawn on top of the current state. `mouthOffsets` (optional) moves the overlay per frame, in sprite pixels, when the head moves.

4. Set `"spritesDir": "sprites/<pack>"` in the config.

`CHARACTER.md` has a prompt for an AI pixel-art tool. The placeholder pack is drawn by `scripts/make-placeholder-sprites.js`.

## 8. Test without Claude Code

```bash
P=http://127.0.0.1:47823/event
curl -X POST --data '{"hook_event_name":"SessionStart","session_id":"a","cwd":"/tmp/demo"}' $P
curl -X POST --data '{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"a","cwd":"/tmp/demo"}' $P
curl -X POST --data '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash","session_id":"a","cwd":"/tmp/demo"}' $P
curl -X POST --data '{"hook_event_name":"Stop","session_id":"a","cwd":"/tmp/demo","transcript_path":"/nonexistent"}' $P
```

## Privacy

- Transcripts are read only on Stop and when Fern reads a session, then dropped. Nothing is logged or stored.
- Your prompt is shown in the bubble and not kept.
- Your voiceprint is `~/.claude-avatar/voiceprint.json` (numbers only, no audio, owner read/write only). Tray > *Forget my voice* deletes it.
- Audio is never written to disk except the short whisper temp file.

## Fan art note

The placeholder sprites show Fern from *Frieren: Beyond Journey's End*. The character belongs to its owners. This pack is for personal, local use only. Do not publish or sell it.
