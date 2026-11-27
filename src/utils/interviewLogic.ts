import type {
  CapturedNote,
  InterviewProfile,
  InterviewRecord,
  InterviewSummary,
  PainPointItem,
  TranscriptEntry,
} from '../types/interview.ts';
import { getSectionsForProfile } from '../data/questionnaires.ts';

/**
 * Computes Root Mean Square (RMS) energy of a mono PCM float32 audio frame.
 * Used for real-time waveform bars and adaptive single-speaker noise gating.
 */
export function computeAudioRms(samples: Float32Array): number {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Linear resampler for normalizing microphone audio to 16kHz mono PCM
 * when the browser's AudioContext runs at 44.1kHz or 48kHz.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (!samples || samples.length === 0 || fromRate === toRate || fromRate <= 0 || toRate <= 0) {
    return samples;
  }
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(outputLength);
  const lastIndex = samples.length - 1;
  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = samples[Math.min(idx, lastIndex)];
    const s1 = samples[Math.min(idx + 1, lastIndex)];
    output[i] = s0 + (s1 - s0) * frac;
  }
  return output;
}

/**
 * Encodes Float32 PCM samples (-1..1) directly into a little-endian 16-bit PCM ArrayBuffer
 * for zero-base64 binary WebSocket streaming.
 */
export function float32ToPcm16Buffer(float32: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/**
 * Decodes a little-endian 16-bit PCM ArrayBuffer into Float32 samples (-1..1)
 * for direct Web Audio playback without base64/JSON overhead.
 */
export function pcm16BufferToFloat32(buffer: ArrayBuffer): Float32Array {
  const sampleCount = Math.floor(buffer.byteLength / 2);
  const float32 = new Float32Array(sampleCount);
  const view = new DataView(buffer);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

/**
 * Computes an adaptive jitter-buffer pre-roll duration (in seconds).
 * Starts at 140ms to smoothly absorb mobile/international jitter without noticeable lag,
 * and grows gently up to 260ms if mid-turn underruns occur.
 */
export function computeAdaptivePreRoll(
  underrunCount: number,
  baseSeconds = 0.14,
  maxSeconds = 0.26
): number {
  const safeCount = Math.max(0, Math.floor(underrunCount));
  return Math.min(maxSeconds, baseSeconds + safeCount * 0.04);
}

/**
 * Anti-aliased box-filter downsampler for normalizing native hardware microphone audio
 * (44.1kHz / 48kHz) to 16kHz mono PCM without Nyquist aliasing artifacts.
 */
export function downsampleBoxFilter(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (!samples || samples.length === 0 || fromRate === toRate || fromRate <= 0 || toRate <= 0) {
    return samples;
  }
  if (fromRate < toRate) {
    return resampleLinear(samples, fromRate, toRate);
  }
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(outputLength);
  let acc = 0;
  let count = 0;
  let phase = 0;
  let outIdx = 0;
  for (let i = 0; i < samples.length && outIdx < outputLength; i++) {
    acc += samples[i];
    count += 1;
    phase += 1;
    if (phase >= ratio) {
      output[outIdx++] = acc / count;
      phase -= ratio;
      acc = 0;
      count = 0;
    }
  }
  return outIdx === outputLength ? output : output.subarray(0, outIdx);
}

/**
 * Adaptive jitter-buffered playback scheduler for gapless streaming PCM audio.
 * Adds a smooth pre-roll cushion on turn start or network underrun, and schedules
 * back-to-back with zero gap during steady streaming.
 */
export function computePlaybackSchedule(
  currentTime: number,
  nextStartTime: number,
  chunkDuration: number,
  preRollSeconds = 0.14
): { startAt: number; nextStartTime: number; isRecovery: boolean } {
  const safeDuration = Math.max(0, chunkDuration);
  const isRecovery = nextStartTime <= currentTime + 0.006;
  const startAt = isRecovery ? currentTime + preRollSeconds : nextStartTime;
  return {
    startAt,
    nextStartTime: startAt + safeDuration,
    isRecovery,
  };
}

/**
 * Single-speaker voice focus gate.
 * Filters low-level ambient noise, distant secondary background voices, and
 * speaker echo bleed while Anaïs is speaking, while preserving natural word endings.
 */
export interface VoiceGateState {
  noiseFloor: number;
  hangoverFrames: number;
}

export function evaluateVoiceFocusGate(
  rms: number,
  state: VoiceGateState,
  voiceIsolationEnabled: boolean,
  isAgentSpeaking = false
): { allowTransmit: boolean; nextState: VoiceGateState; normalizedLevel: number } {
  const normalizedLevel = Math.min(1, rms * 6.5);

  if (!voiceIsolationEnabled) {
    return {
      allowTransmit: true,
      nextState: state,
      normalizedLevel,
    };
  }

  // Adaptive noise floor tracks quiet background ambience only (never rises on speech)
  const clampedFloor = Math.max(0.0015, Math.min(0.008, state.noiseFloor));
  const baseThreshold = Math.max(0.0028, clampedFloor * 1.4);
  // While Anaïs is speaking, raise threshold so speaker bleed does not trigger false cuts,
  // while still permitting clear intentional human barge-in on the first word.
  const speechThreshold = isAgentSpeaking
    ? Math.max(0.022, baseThreshold * 2.4)
    : baseThreshold;

  if (rms >= speechThreshold) {
    return {
      allowTransmit: true,
      nextState: {
        // Keep noiseFloor frozen during speech so speaking never raises the next-word threshold
        noiseFloor: clampedFloor,
        hangoverFrames: isAgentSpeaking ? 6 : 12, // ~384-768ms at 64ms/frame: preserves soft endings & pauses
      },
      normalizedLevel,
    };
  }

  if (state.hangoverFrames > 0) {
    return {
      allowTransmit: true,
      nextState: {
        noiseFloor: clampedFloor,
        hangoverFrames: state.hangoverFrames - 1,
      },
      normalizedLevel: normalizedLevel * 0.65,
    };
  }

  // Quiet or distant background chatter: slowly track ambient floor
  return {
    allowTransmit: false,
    nextState: {
      noiseFloor: isAgentSpeaking
        ? clampedFloor
        : Math.min(0.008, clampedFloor * 0.94 + rms * 0.06),
      hangoverFrames: 0,
    },
    normalizedLevel: normalizedLevel * 0.2,
  };
}

/**
 * Applies a click-free linear gain ramp across a PCM frame when transitioning
 * between active speech and muted/suppressed silence.
 */
export function applySmoothGainRamp(
  samples: Float32Array,
  fromGain: number,
  toGain: number,
  rampSamples = 64
): Float32Array {
  const out = new Float32Array(samples.length);
  if (fromGain === toGain) {
    if (toGain === 0) return out;
    if (toGain === 1) {
      out.set(samples);
      return out;
    }
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i] * toGain;
    }
    return out;
  }

  const effectiveRamp = Math.max(1, Math.min(rampSamples, samples.length));
  for (let i = 0; i < samples.length; i++) {
    const t = i < effectiveRamp ? i / effectiveRamp : 1;
    const gain = fromGain + (toGain - fromGain) * t;
    out[i] = samples[i] * gain;
  }
  return out;
}

/**
 * Strips non-speech ASR control artifacts (e.g. "[no speech]", "<noise>", "[silence]")
 * and any leaked tool-call JSON payloads from live transcription fragments so they
 * never appear in transcripts or summaries.
 */
export function cleanLiveTranscriptFragment(raw: string): string {
  const cleaned = String(raw || '')
    .replace(/[：:]?\s*\{[^{}]*"(?:questionId|painLevel|wantsStudyResults|wantsFollowUpCall|answer)"[^{}]*\}/gi, '')
    .replace(/\[(?:no[\s_-]*speech|silence|noise|inaudible|music)\]/gi, '')
    .replace(/<(?:no[\s_-]*speech|silence|noise|inaudible)>/gi, '')
    .replace(/^\s*(?:no[\s_-]*speech)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned;
}

/**
 * Calculates interview theme coverage progress based on captured notes and transcript.
 */
export function calculateThemeProgress(
  profile: InterviewProfile,
  capturedNotes: CapturedNote[],
  transcript: TranscriptEntry[]
): {
  completedSections: string[];
  totalSections: number;
  percent: number;
  activeSectionCode: string;
} {
  const sections = getSectionsForProfile(profile);
  const covered = new Set<string>();

  for (const note of capturedNotes) {
    if (note.section) covered.add(note.section.toUpperCase());
  }
  for (const entry of transcript) {
    if (entry.themeCode) covered.add(entry.themeCode.toUpperCase());
  }

  const completedSections = sections
    .map((s) => s.code)
    .filter((code) => covered.has(code));

  const nextUnfinished = sections.find((s) => !covered.has(s.code));
  const activeSectionCode = nextUnfinished
    ? nextUnfinished.code
    : sections[sections.length - 1]?.code ?? 'A';

  const percent =
    sections.length === 0
      ? 0
      : Math.round((completedSections.length / sections.length) * 100);

  return {
    completedSections,
    totalSections: sections.length,
    percent,
    activeSectionCode,
  };
}

/**
 * Validates and sanitizes an interview ID for safe server storage and URLs.
 */
export function isValidInterviewId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{4,64}$/.test(id);
}

const LEGACY_SEED_IDS = new Set([
  'seed-mkt-abidjan-01',
  'seed-dg-abidjan-02',
]);

/**
 * Identifies legacy demo/seed interview IDs so real history only displays
 * genuine interviews conducted by users.
 */
export function isLegacySeedId(id: string): boolean {
  return LEGACY_SEED_IDS.has(id);
}

/**
 * Formats seconds into mm:ss display string.
 */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Filters interview history by profile and search query.
 */
export function filterInterviews(
  interviews: InterviewRecord[],
  profileFilter: 'all' | InterviewProfile,
  query: string
): InterviewRecord[] {
  const normalized = query.trim().toLowerCase();

  return interviews
    .filter((item) => {
      if (profileFilter !== 'all' && item.profile !== profileFilter) {
        return false;
      }
      if (!normalized) return true;

      const searchable = [
        item.participantName,
        item.companyName,
        item.summary.headline,
        item.summary.executiveSummary,
        ...item.summary.keyPainPoints.map((p) => `${p.title} ${p.category} ${p.impact}`),
      ]
        .join(' ')
        .toLowerCase();

      return searchable.includes(normalized);
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Builds a concise French continuation summary when reconnecting a dropped live voice
 * session so Anaïs picks up seamlessly without repeating already-covered questions.
 */
export function buildResumeContext(
  transcript: TranscriptEntry[],
  capturedNotes: CapturedNote[]
): string {
  if (transcript.length === 0 && capturedNotes.length === 0) {
    return '';
  }
  const recentLines = transcript
    .slice(-6)
    .map((t) => `${t.speaker === 'anais' ? 'Anaïs' : 'Participant'}: ${t.text}`)
    .join('\n');
  const notesSummary = capturedNotes
    .slice(-8)
    .map((n) => `${n.questionId} (${n.topic}): ${n.answer}`)
    .join('; ');

  return [
    notesSummary ? `Points déjà notés : ${notesSummary}` : '',
    recentLines ? `Derniers échanges :\n${recentLines}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1400);
}

/**
 * Strips any audio data URI prefix (including codec parameters such as
 * `data:audio/webm;codecs=opus;base64,`) before base64 decoding.
 */
export function stripAudioDataUriPrefix(raw: string): string {
  return raw.replace(/^data:audio\/[a-z0-9.+-]+(?:;[^;,]+)*;base64,/i, '');
}

/**
 * Normalizes French typography characters that standard PDF WinAnsi fonts
 * render poorly (ligatures, typographic dashes, curly quotes, ellipsis).
 */
export function sanitizePdfText(text: string): string {
  return String(text || '')
    .replace(/\u0153/g, 'oe')
    .replace(/\u0152/g, 'OE')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/**
 * Generates a clean, safe filename for PDF export.
 */
export function buildPdfFilename(record: InterviewRecord): string {
  const slug = (record.companyName || record.participantName || 'anonyme')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 32);

  const datePart = record.createdAt.slice(0, 10);
  const rolePart = record.profile === 'marketing' ? 'marketing' : 'dg';
  return `agence-x-synthese-${rolePart}-${slug || 'entretien'}-${datePart}.pdf`;
}

/**
 * Offline-safe structured summary builder used ONLY when the browser has no network
 * connectivity at interview completion so the user still gets an immediate report
 * that can be exported to PDF and synced later.
 */
export function buildOfflineSummary(
  profile: InterviewProfile,
  participantName: string,
  companyName: string,
  transcript: TranscriptEntry[],
  capturedNotes: CapturedNote[]
): InterviewSummary {
  const participantLines = transcript
    .filter((t) => t.speaker === 'participant')
    .map((t) => t.text.trim())
    .filter(Boolean);

  const painPoints: PainPointItem[] = capturedNotes
    .filter((n) => n.painLevel === 'high' || n.painLevel === 'medium')
    .slice(0, 4)
    .map((n) => ({
      title: n.topic,
      category: `Bloc ${n.section}`,
      severity: n.painLevel === 'high' ? 'Critique' : 'Élevé',
      impact: n.answer,
      recommendedAction:
        profile === 'marketing'
          ? "Mettre en place un diagnostic procédures et des automatisations ciblées sur vos outils actuels."
          : "Sécuriser les validations et centraliser les indicateurs de pilotage dans un tableau de bord fiable.",
    }));

  if (painPoints.length === 0) {
    painPoints.push({
      title:
        profile === 'marketing'
          ? 'Points de friction opérationnels marketing évoqués'
          : 'Enjeux de pilotage et structuration évoqués',
      category: 'Synthèse locale hors ligne',
      severity: 'Élevé',
      impact:
        participantLines[0] ||
        "Échange enregistré localement en attente de synchronisation pour enrichissement complet.",
      recommendedAction:
        "Synchroniser l'entretien dès le retour de la connexion pour affiner le diagnostic.",
    });
  }

  return {
    headline:
      profile === 'marketing'
        ? `Synthèse Marketing · ${companyName || participantName || 'Participant anonyme'}`
        : `Synthèse Direction Générale · ${companyName || participantName || 'Participant anonyme'}`,
    executiveSummary:
      participantLines.length > 0
        ? `Entretien réalisé avec ${participantName || 'un interlocuteur'} (${companyName || 'PME ivoirienne'}). ${participantLines.slice(0, 2).join(' ')}`
        : "Entretien sauvegardé localement. Les réponses captées et la transcription complète sont prêtes pour consultation hors ligne et export PDF.",
    timeLostEstimate: 'À confirmer lors de la consolidation',
    maturityLevel: 'Sauvegarde hors ligne',
    keyPainPoints: painPoints,
    recommendedOffers: [
      {
        offer: 'Audit & Procédures',
        relevance: 'Prioritaire',
        rationale: "Clarifier les circuits de validation et structurer les pratiques clés identifiées durant l'échange.",
      },
      {
        offer: 'Agents & Automatisations',
        relevance: 'Complémentaire',
        rationale: "Connecter les outils quotidiens (WhatsApp, Excel, suivi clients) pour supprimer les ressaisies.",
      },
    ],
    structuredAnswers: capturedNotes.map((n) => ({
      questionId: n.questionId,
      section: n.section,
      label: n.topic,
      value: n.answer,
    })),
    decisionFactors: [
      'Gains de temps mesurables au quotidien',
      'Accompagnement pragmatique adapté aux PME ivoiriennes',
    ],
    nextSteps:
      "Exporter ce rapport en PDF ou partager les conclusions lors d'un échange de 20 minutes avec L'Agence X.",
    generatedBy: 'Synthese locale (mode hors ligne)',
  };
}

/**
 * Safely clamps an untrusted duration value (in seconds) into [0, 7200],
 * returning 0 for NaN, Infinity, or non-numeric inputs.
 */
export function sanitizeDurationSeconds(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(7200, Math.floor(num));
}

/**
 * Strips control characters and collapses newlines from short user fields
 * (first name, company name) before embedding them in AI prompts.
 */
export function sanitizePromptField(raw: unknown, maxLength = 120): string {
  return String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Parses a single HTTP `Range: bytes=...` header (including open-ended and suffix ranges)
 * against a known file byte length. Returns null when invalid or unsatisfiable.
 */
export function parseHttpByteRange(
  rangeHeader: string,
  totalSize: number
): { start: number; end: number } | null {
  if (!Number.isInteger(totalSize) || totalSize <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return null;

  let start: number;
  let end: number;

  if (!startStr && endStr) {
    // Suffix byte range: last N bytes
    const suffixLen = parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? Math.min(parseInt(endStr, 10), totalSize - 1) : totalSize - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start > end ||
    start >= totalSize
  ) {
    return null;
  }
  return { start, end };
}

/**
 * Dual-threshold speaker silence detector:
 * - End of turn (turnComplete = true): unlock mic quickly after 40ms of silence
 *   so the participant is heard on the very first try.
 * - Mid-turn (turnComplete = false): preserve echo protection across Anaïs's natural
 *   breathing pauses by waiting 260ms before unlocking.
 */
export function shouldUnlockMicOnOutputSilence(
  silentSamples: number,
  sampleRate: number,
  turnComplete: boolean
): boolean {
  if (sampleRate <= 0) return false;
  const cutoffMs = turnComplete ? 0.04 : 0.26;
  const minSamples = turnComplete ? 384 : 1536;
  const cutoffSamples = Math.max(minSamples, Math.round(sampleRate * cutoffMs));
  return silentSamples >= cutoffSamples;
}

/**
 * Detects audio container MIME type from leading file magic bytes so both
 * Chrome/Firefox WebM and Safari/iOS MP4 recordings stream with accurate Content-Type.
 */
export function detectAudioContentType(headerBytes: Uint8Array): string {
  if (headerBytes.length >= 4) {
    // WebM / Matroska EBML header: 0x1A 0x45 0xDF 0xA3
    if (
      headerBytes[0] === 0x1a &&
      headerBytes[1] === 0x45 &&
      headerBytes[2] === 0xdf &&
      headerBytes[3] === 0xa3
    ) {
      return 'audio/webm';
    }
    // Ogg container: "OggS"
    if (
      headerBytes[0] === 0x4f &&
      headerBytes[1] === 0x67 &&
      headerBytes[2] === 0x67 &&
      headerBytes[3] === 0x53
    ) {
      return 'audio/ogg';
    }
    // WAV container: "RIFF"
    if (
      headerBytes[0] === 0x52 &&
      headerBytes[1] === 0x49 &&
      headerBytes[2] === 0x46 &&
      headerBytes[3] === 0x46
    ) {
      return 'audio/wav';
    }
  }
  // ISO BMFF / MP4 / M4A: "ftyp" at byte offset 4..7
  if (
    headerBytes.length >= 8 &&
    headerBytes[4] === 0x66 &&
    headerBytes[5] === 0x74 &&
    headerBytes[6] === 0x79 &&
    headerBytes[7] === 0x70
  ) {
    return 'audio/mp4';
  }
  return 'audio/webm';
}

/**
 * Joins streaming French transcript fragments cleanly without adding spurious
 * spaces after apostrophes/hyphens or before punctuation.
 */
export function joinFrenchTranscriptFragment(existing: string, nextFragment: string): string {
  const prev = existing;
  const next = nextFragment.trim();
  if (!next) return prev;
  if (!prev) return next;
  const noSpaceNeeded =
    prev.endsWith(' ') ||
    prev.endsWith("'") ||
    prev.endsWith('’') ||
    prev.endsWith('-') ||
    /^[.,!?;:)]/.test(next);
  return `${prev}${noSpaceNeeded ? '' : ' '}${next}`;
}

/**
 * Resolves an API or audio path against an optional external backend base URL
 * (e.g. VITE_BACKEND_URL when frontend is hosted on Vercel and backend on Cloud Run/Render/Railway).
 */
export function resolveBackendApiUrl(
  pathOrUrl: string,
  backendBaseUrl?: string
): string {
  const trimmed = pathOrUrl.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('blob:')) {
    return trimmed;
  }
  const base = (backendBaseUrl || '').trim().replace(/\/+$/, '');
  const normalizedPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (!base) {
    return normalizedPath;
  }
  return `${base}${normalizedPath}`;
}

/**
 * Resolves the `/ws/live` WebSocket URL using either an explicit backend base URL
 * or the current browser origin.
 */
export function resolveLiveWebSocketUrl(
  locationLike: { protocol: string; host: string },
  backendBaseUrl?: string
): string {
  const base = (backendBaseUrl || '').trim().replace(/\/+$/, '');
  if (base) {
    try {
      const parsed = new URL(base);
      const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProtocol}//${parsed.host}/ws/live`;
    } catch {
      // Fallback to same-origin if malformed
    }
  }
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/ws/live`;
}

/**
 * Parses a comma-separated ALLOWED_ORIGINS env var into normalized origin strings
 * (e.g. "https://mon-app.vercel.app").
 */
export function parseAllowedOrigins(raw?: string): Set<string> {
  const origins = new Set<string>();
  if (!raw) return origins;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        origins.add(parsed.origin.toLowerCase());
      }
    } catch {
      // Ignore malformed origin entries
    }
  }
  return origins;
}



