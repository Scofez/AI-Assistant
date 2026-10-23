const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// Speaker order of kokoro-multi-lang-v1_0. The index is the speaker id (sid).
const VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  'ef_dora', 'em_alex', 'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'if_sara', 'im_nicola',
  'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo', 'pf_dora', 'pm_alex', 'pm_santa',
  'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang', 'em_santa',
];

// Female voices offered in the tray. "jf" voices read English with a Japanese accent.
const MENU_VOICES = [
  'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro',
  'af_heart', 'af_bella', 'af_nicole', 'af_sky', 'bf_emma', 'bf_lily',
];

let ttsPromise;
let loadedDir;

/** Loads the model once, off the main thread. A failed load is retried on the next call. */
function load(dir) {
  if (ttsPromise && loadedDir === dir) return ttsPromise;
  const { OfflineTts } = require('sherpa-onnx-node');
  loadedDir = dir;
  ttsPromise = OfflineTts.createAsync({
    model: {
      kokoro: {
        model: path.join(dir, 'model.onnx'),
        voices: path.join(dir, 'voices.bin'),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
        lexicon: [path.join(dir, 'lexicon-us-en.txt'), path.join(dir, 'lexicon-zh.txt')].join(','),
      },
      numThreads: 2,
      debug: false,
    },
    maxNumSentences: 1,
  });
  ttsPromise.catch(() => { ttsPromise = undefined; });
  return ttsPromise;
}

/**
 * Speaks `text` into a temporary WAV file. The caller plays it, then calls cleanup().
 */
async function synthesize({ kokoroDir, kokoroVoice, kokoroSpeed }, text) {
  const sid = VOICES.indexOf(kokoroVoice);
  if (sid < 0) throw new Error(`Unknown Kokoro voice ${kokoroVoice}`);
  const tts = await load(kokoroDir);
  // Electron does not allow external buffers, so the samples are copied.
  const audio = await tts.generateAsync({ text, sid, speed: kokoroSpeed, enableExternalBuffer: false });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-avatar-tts-'));
  const file = path.join(dir, 'speech.wav');
  require('sherpa-onnx-node').writeWave(file, { samples: audio.samples, sampleRate: audio.sampleRate });
  return { file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

module.exports = { VOICES, MENU_VOICES, synthesize, load };
