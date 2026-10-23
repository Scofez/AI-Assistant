const PRIORITY = ['sleeping', 'idle', 'greet', 'thinking', 'working', 'done', 'attention'];
const SLEEP_AFTER_MS = 10 * 60 * 1000;
const TIMED = { greet: 2000, done: 6000 };

/**
 * Tracks one state per Claude session and reports the most urgent one.
 * Timed states (greet, done) fall back to idle by themselves.
 */
function createStateMachine(onChange) {
  const sessions = new Map();
  let isAsleep = false;
  let sleepTimer;
  let shown;

  function display() {
    let best = isAsleep ? 'sleeping' : 'idle';
    for (const { state } of sessions.values()) {
      if (PRIORITY.indexOf(state) > PRIORITY.indexOf(best)) best = state;
    }
    if (best !== shown) {
      shown = best;
      onChange(best);
    }
  }

  function set(sessionId, state) {
    const prev = sessions.get(sessionId);
    clearTimeout(prev?.timer);
    const entry = { state };
    if (TIMED[state]) {
      entry.timer = setTimeout(() => set(sessionId, 'idle'), TIMED[state]);
    }
    sessions.set(sessionId, entry);
    display();
  }

  function touch() {
    isAsleep = false;
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      isAsleep = true;
      for (const [id, { state }] of sessions) {
        if (state !== 'attention') set(id, 'sleeping');
      }
      display();
    }, SLEEP_AFTER_MS);
  }

  return {
    /** Applies a hook event. Returns nothing; speech is handled elsewhere. */
    handle(event, sessionId) {
      touch();
      switch (event) {
        case 'SessionStart': return set(sessionId, 'greet');
        case 'UserPromptSubmit': return set(sessionId, 'thinking');
        case 'PreToolUse': return set(sessionId, 'working');
        case 'PostToolUse': return set(sessionId, 'thinking');
        case 'Notification': return set(sessionId, 'attention');
        case 'Stop': return set(sessionId, 'done');
        case 'SessionEnd':
          clearTimeout(sessions.get(sessionId)?.timer);
          sessions.delete(sessionId);
          return display();
        default: return display();
      }
    },
    /** Click on the avatar clears every attention state. */
    clearAttention() {
      for (const [id, { state }] of sessions) if (state === 'attention') set(id, 'idle');
    },
    current: () => shown,
    stateOf: (sessionId) => sessions.get(sessionId)?.state,
    start() {
      touch();
      display();
    },
  };
}

module.exports = { createStateMachine };
