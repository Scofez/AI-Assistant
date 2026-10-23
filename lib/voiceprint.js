const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

const VOICEPRINT_FILE = path.join(CONFIG_DIR, 'voiceprint.json');

let extractor;
let extractorModel;

/** Loads the native model once. Throws a readable error when it is missing. */
function getExtractor(modelPath) {
  if (extractor && extractorModel === modelPath) return extractor;
  if (!fs.existsSync(modelPath)) throw new Error(`Speaker model not found at ${modelPath}`);
  const { SpeakerEmbeddingExtractor } = require('sherpa-onnx-node');
  extractor = new SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false });
  extractorModel = modelPath;
  return extractor;
}

/** Reads a mono PCM16 WAV. Walks the chunks, because some writers add extra ones. */
function wavToSamples(wav) {
  let sampleRate;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') sampleRate = wav.readUInt32LE(offset + 12);
    if (id === 'data' && sampleRate) {
      const count = Math.floor(Math.min(size, wav.length - offset - 8) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = wav.readInt16LE(offset + 8 + i * 2) / 0x8000;
      return { samples, sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('Not a PCM WAV file');
}

function normalize(vector) {
  const norm = Math.hypot(...vector) || 1;
  return Array.from(vector, (v) => v / norm);
}

/** Speaker embedding of one utterance, as a unit vector. */
function embed(modelPath, wav) {
  const ex = getExtractor(modelPath);
  const stream = ex.createStream();
  stream.acceptWaveform(wavToSamples(wav));
  stream.inputFinished();
  if (!ex.isReady(stream)) throw new Error('Clip is too short to identify the voice');
  return normalize(ex.compute(stream, false));
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

const MAX_EMBEDDINGS = 5;

/** Returns the saved voiceprints, one per microphone. Old files have one `embedding`. */
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(VOICEPRINT_FILE, 'utf8'));
    const embeddings = data.embeddings ?? (Array.isArray(data.embedding) ? [data.embedding] : []);
    return embeddings.length ? { ...data, embeddings } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Saves the mean of the enrollment embeddings. With `append`, it is added
 * next to the earlier ones (for a second microphone). Only numbers are
 * stored, never audio. The file is readable by the owner only.
 */
function enroll(modelPath, wavs, { append = false } = {}) {
  const vectors = wavs.map((wav) => embed(modelPath, wav));
  const mean = vectors[0].map((_v, i) => vectors.reduce((sum, vec) => sum + vec[i], 0) / vectors.length);
  const earlier = append ? (load()?.embeddings ?? []) : [];
  const embeddings = [...earlier, normalize(mean)].slice(-MAX_EMBEDDINGS);
  const data = { model: path.basename(modelPath), updatedAt: new Date().toISOString(), embeddings };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(VOICEPRINT_FILE, JSON.stringify(data), { mode: 0o600 });
  return data;
}

/** Returns the best similarity to any saved voiceprint, from -1 to 1, or undefined without one. */
function score(modelPath, wav) {
  const saved = load();
  if (!saved) return undefined;
  const heard = embed(modelPath, wav);
  return Math.max(...saved.embeddings.map((e) => cosine(e, heard)));
}

function forget() {
  fs.rmSync(VOICEPRINT_FILE, { force: true });
}

module.exports = {
  VOICEPRINT_FILE, enroll, score, forget,
  hasVoiceprint: () => Boolean(load()),
  count: () => load()?.embeddings.length ?? 0,
};
