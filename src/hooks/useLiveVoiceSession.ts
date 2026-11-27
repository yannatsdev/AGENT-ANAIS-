import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CapturedNote,
  InterviewProfile,
  TranscriptEntry,
  VoiceEngine,
} from '../types/interview';
import {
  MIC_CAPTURE_WORKLET_SOURCE,
  VOICE_PLAYER_WORKLET_SOURCE,
} from '../utils/audioWorklets';
import { getApiUrl, getLiveWsUrl } from '../utils/apiConfig';
import {
  applySmoothGainRamp,
  buildResumeContext,
  computeAdaptivePreRoll,
  computeAudioRms,
  computePlaybackSchedule,
  downsampleBoxFilter,
  evaluateVoiceFocusGate,
  float32ToPcm16Buffer,
  formatDuration,
  joinFrenchTranscriptFragment,
  pcm16BufferToFloat32,
  VoiceGateState,
} from '../utils/interviewLogic';

export type CallStatus =
  | 'connecting'
  | 'reconnecting'
  | 'listening'
  | 'speaking'
  | 'error'
  | 'ended';

export interface LiveSessionResult {
  durationSeconds: number;
  transcript: TranscriptEntry[];
  capturedNotes: CapturedNote[];
  contactInfo?: string;
  audioBlob: Blob | null;
}

interface UseLiveVoiceSessionOptions {
  profile: InterviewProfile;
  engine: VoiceEngine;
  participantName: string;
  companyName: string;
  active: boolean;
  onRequestConfirmation?: () => void;
}

function base64Pcm16ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const sampleCount = Math.floor(bytes.length / 2);
  const float32 = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

const BAR_COUNT = 17;
const IDLE_BARS = [
  0.18, 0.25, 0.36, 0.44, 0.56, 0.48, 0.38, 0.28, 0.2, 0.16, 0.18, 0.24, 0.34,
  0.46, 0.52, 0.4, 0.26,
];

const RECONNECT_DELAYS_MS = [700, 1500, 3000, 5000];

export function useLiveVoiceSession(options: UseLiveVoiceSessionOptions) {
  const {
    profile,
    engine,
    participantName,
    companyName,
    active,
    onRequestConfirmation,
  } = options;

  const [status, setStatus] = useState<CallStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micAvailable, setMicAvailable] = useState<boolean>(true);
  const [isAnaisMuted, setIsAnaisMuted] = useState<boolean>(false);
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [voiceIsolationEnabled, setVoiceIsolationEnabled] =
    useState<boolean>(true);
  const [durationSeconds, setDurationSeconds] = useState<number>(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [capturedNotes, setCapturedNotes] = useState<CapturedNote[]>([]);
  const [waveformBars, setWaveformBars] = useState<number[]>(IDLE_BARS);
  const [backgroundNoiseSuppressed, setBackgroundNoiseSuppressed] =
    useState<boolean>(false);

  // Single native-rate AudioContext + off-main-thread AudioWorklets
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const anaisGainRef = useRef<GainNode | null>(null);
  const playerWorkletRef = useRef<AudioWorkletNode | null>(null);
  const micWorkletRef = useRef<AudioWorkletNode | null>(null);
  const workletUrlsRef = useRef<string[]>([]);

  // Fallback playback & capture refs (only used if AudioWorklet is unavailable)
  const fallbackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const fallbackMicProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const underrunCountRef = useRef<number>(0);
  const hadUnderrunThisTurnRef = useRef<boolean>(false);

  const micStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const voiceGateRef = useRef<VoiceGateState>({
    noiseFloor: 0.008,
    hangoverFrames: 0,
  });

  const statusRef = useRef<CallStatus>('connecting');
  const noiseSuppressedRef = useRef<boolean>(false);
  const lastNoiseUiChangeRef = useRef<number>(0);
  const prevTransmitGainRef = useRef<number>(0.65);
  const queuedAudioEndAtRef = useRef<number>(0);
  const modelTurnActiveRef = useRef<boolean>(false);
  const turnCompletePendingRef = useRef<boolean>(false);
  const echoTailUntilRef = useRef<number>(0);
  const bargeInStreakRef = useRef<number>(0);
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const intentionalCloseRef = useRef<boolean>(false);
  const pendingTextQueueRef = useRef<string[]>([]);
  const openSocketRef = useRef<((isReconnect?: boolean) => void) | null>(null);

  const isAnaisMutedRef = useRef(false);
  const isMicMutedRef = useRef(false);
  const voiceIsolationRef = useRef(true);
  const startTimeRef = useRef<number>(Date.now());
  const durationRef = useRef<number>(0);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const notesRef = useRef<CapturedNote[]>([]);
  const contactInfoRef = useRef<string | undefined>(undefined);
  const energyRef = useRef<number>(0.12);
  const isSpeakingRef = useRef<boolean>(false);
  const speakingTimerRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const finishedRef = useRef<boolean>(false);
  const onRequestConfirmationRef = useRef(onRequestConfirmation);
  onRequestConfirmationRef.current = onRequestConfirmation;

  const setStatusSafe = useCallback((next: CallStatus) => {
    if (statusRef.current !== next) {
      statusRef.current = next;
      setStatus(next);
    }
  }, []);

  const setNoiseSuppressedSafe = useCallback((next: boolean) => {
    const now = performance.now();
    if (
      noiseSuppressedRef.current !== next &&
      now - lastNoiseUiChangeRef.current > 450
    ) {
      noiseSuppressedRef.current = next;
      lastNoiseUiChangeRef.current = now;
      setBackgroundNoiseSuppressed(next);
    }
  }, []);

  const stopAnaisPlayback = useCallback(() => {
    if (speakingTimerRef.current) {
      window.clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }

    if (playerWorkletRef.current) {
      try {
        playerWorkletRef.current.port.postMessage({ type: 'clear' });
      } catch {
        // Ignore if disconnected
      }
    }

    const ctx = audioCtxRef.current;
    const gain = anaisGainRef.current;
    if (ctx && gain && fallbackSourcesRef.current.size > 0) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.015);
    }
    for (const src of fallbackSourcesRef.current) {
      try {
        src.onended = null;
        src.stop(ctx ? ctx.currentTime + 0.016 : undefined);
      } catch {
        // Already stopped
      }
    }
    fallbackSourcesRef.current.clear();
    if (ctx) {
      nextStartTimeRef.current = ctx.currentTime;
      if (gain && !isAnaisMutedRef.current) {
        gain.gain.setValueAtTime(1, ctx.currentTime + 0.025);
      }
    }

    queuedAudioEndAtRef.current = 0;
    modelTurnActiveRef.current = false;
    turnCompletePendingRef.current = false;
    isSpeakingRef.current = false;
    echoTailUntilRef.current = performance.now() + 35;
    bargeInStreakRef.current = 0;
  }, []);

  const toggleAnaisMute = useCallback(() => {
    setIsAnaisMuted((prev) => {
      const next = !prev;
      isAnaisMutedRef.current = next;
      if (anaisGainRef.current && audioCtxRef.current) {
        const now = audioCtxRef.current.currentTime;
        anaisGainRef.current.gain.cancelScheduledValues(now);
        anaisGainRef.current.gain.setTargetAtTime(next ? 0 : 1, now, 0.015);
      }
      if (next) {
        stopAnaisPlayback();
      }
      return next;
    });
  }, [stopAnaisPlayback]);

  const toggleMicMute = useCallback(() => {
    setIsMicMuted((prev) => {
      const next = !prev;
      isMicMutedRef.current = next;
      return next;
    });
  }, []);

  const toggleVoiceIsolation = useCallback(() => {
    setVoiceIsolationEnabled((prev) => {
      const next = !prev;
      voiceIsolationRef.current = next;
      if (!next) {
        noiseSuppressedRef.current = false;
        setBackgroundNoiseSuppressed(false);
      }
      return next;
    });
  }, []);

  const appendTranscript = useCallback(
    (speaker: 'anais' | 'participant', text: string) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const stamp = formatDuration(elapsed);

      setTranscript((prev) => {
        const last = prev[prev.length - 1];
        let next: TranscriptEntry[];
        if (last && last.speaker === speaker && last.text.length < 480) {
          next = [
            ...prev.slice(0, -1),
            {
              ...last,
              text: joinFrenchTranscriptFragment(last.text, cleaned),
            },
          ];
        } else {
          next = [
            ...prev,
            {
              id: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              speaker,
              text: cleaned,
              timestamp: stamp,
            },
          ];
        }
        transcriptRef.current = next;
        return next;
      });
    },
    []
  );

  const reconnect = useCallback(() => {
    if (finishedRef.current) return;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    setErrorMessage(null);
    openSocketRef.current?.(true);
  }, []);

  const sendTextMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      appendTranscript('participant', trimmed);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'text', text: trimmed }));
      } else {
        pendingTextQueueRef.current.push(trimmed);
        if (
          !ws ||
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING
        ) {
          reconnect();
        }
      }
    },
    [appendTranscript, reconnect]
  );

  const cleanupResources = useCallback(async (): Promise<Blob | null> => {
    intentionalCloseRef.current = true;

    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (speakingTimerRef.current) {
      window.clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
    if (confirmTimerRef.current) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }

    stopAnaisPlayback();

    if (wsRef.current) {
      const socket = wsRef.current;
      wsRef.current = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'stop' }));
        }
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close(1000, 'Session ended');
        }
      } catch {
        // Ignore
      }
    }

    let recordedBlob: Blob | null = null;
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recordedBlob = await new Promise<Blob | null>((resolve) => {
        const timeout = window.setTimeout(() => {
          resolve(
            recordedChunksRef.current.length > 0
              ? new Blob(recordedChunksRef.current, { type: 'audio/webm' })
              : null
          );
        }, 800);
        recorder.onstop = () => {
          window.clearTimeout(timeout);
          resolve(
            recordedChunksRef.current.length > 0
              ? new Blob(recordedChunksRef.current, {
                  type: recorder.mimeType || 'audio/webm',
                })
              : null
          );
        };
        try {
          recorder.stop();
        } catch {
          window.clearTimeout(timeout);
          resolve(null);
        }
      });
    } else if (recordedChunksRef.current.length > 0) {
      recordedBlob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
    }

    if (playerWorkletRef.current) {
      try {
        playerWorkletRef.current.port.onmessage = null;
        playerWorkletRef.current.disconnect();
      } catch {
        // Ignore
      }
      playerWorkletRef.current = null;
    }
    if (micWorkletRef.current) {
      try {
        micWorkletRef.current.port.onmessage = null;
        micWorkletRef.current.disconnect();
      } catch {
        // Ignore
      }
      micWorkletRef.current = null;
    }
    if (fallbackMicProcessorRef.current) {
      try {
        fallbackMicProcessorRef.current.onaudioprocess = null;
        fallbackMicProcessorRef.current.disconnect();
      } catch {
        // Ignore
      }
      fallbackMicProcessorRef.current = null;
    }
    for (const url of workletUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    workletUrlsRef.current = [];

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close();
      } catch {
        // Ignore
      }
      audioCtxRef.current = null;
    }

    return recordedBlob;
  }, [stopAnaisPlayback]);

  const finishSession = useCallback(async (): Promise<LiveSessionResult> => {
    finishedRef.current = true;
    setStatusSafe('ended');
    const audioBlob = await cleanupResources();
    return {
      durationSeconds: durationRef.current,
      transcript: [...transcriptRef.current],
      capturedNotes: [...notesRef.current],
      contactInfo: contactInfoRef.current,
      audioBlob,
    };
  }, [cleanupResources, setStatusSafe]);

  const cancelSession = useCallback(async (): Promise<void> => {
    finishedRef.current = true;
    recordedChunksRef.current = [];
    setStatusSafe('ended');
    await cleanupResources();
    recordedChunksRef.current = [];
  }, [cleanupResources, setStatusSafe]);

  useEffect(() => {
    if (!active) return;

    finishedRef.current = false;
    intentionalCloseRef.current = false;
    reconnectAttemptsRef.current = 0;
    pendingTextQueueRef.current = [];
    startTimeRef.current = Date.now();
    durationRef.current = 0;
    recordedChunksRef.current = [];
    transcriptRef.current = [];
    notesRef.current = [];
    contactInfoRef.current = undefined;
    voiceGateRef.current = { noiseFloor: 0.0025, hangoverFrames: 0 };
    prevTransmitGainRef.current = 0.65;
    queuedAudioEndAtRef.current = 0;
    modelTurnActiveRef.current = false;
    turnCompletePendingRef.current = false;
    echoTailUntilRef.current = 0;
    bargeInStreakRef.current = 0;
    underrunCountRef.current = 0;
    hadUnderrunThisTurnRef.current = false;
    noiseSuppressedRef.current = false;

    setStatusSafe('connecting');
    setErrorMessage(null);
    setDurationSeconds(0);
    setTranscript([]);
    setCapturedNotes([]);
    setBackgroundNoiseSuppressed(false);

    // Duration clock
    const clockInterval = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      durationRef.current = elapsed;
      setDurationSeconds(elapsed);
    }, 1000);

    // Keep-alive WebSocket ping (prevents Cloud Run / mobile proxy timeout during quiet pauses)
    const pingInterval = window.setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);

    // Smooth waveform animation loop (~10Hz to keep main thread ultra-light)
    let lastDraw = 0;
    const animateBars = (now: number) => {
      if (now - lastDraw > 96) {
        lastDraw = now;
        const t = now * 0.0045;
        const energy = energyRef.current;
        const speaking = isSpeakingRef.current && !isAnaisMutedRef.current;
        const nextBars: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          const centerDist =
            Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2);
          const envelope = 1 - centerDist * 0.45;
          const wave =
            0.5 +
            0.35 * Math.sin(t * (speaking ? 2.4 : 1.1) + i * 0.62) +
            0.15 * Math.cos(t * 3.1 - i * 0.9);
          const base = speaking ? 0.24 + energy * 0.78 : 0.14 + energy * 0.65;
          nextBars.push(
            Math.max(0.12, Math.min(1, base * envelope * wave * 1.45))
          );
        }
        setWaveformBars(nextBars);
        energyRef.current = Math.max(0.1, energyRef.current * 0.88);
      }
      animFrameRef.current = requestAnimationFrame(animateBars);
    };
    animFrameRef.current = requestAnimationFrame(animateBars);

    let cancelled = false;

    const markAnaisDrained = () => {
      if (finishedRef.current) return;
      if (speakingTimerRef.current) {
        window.clearTimeout(speakingTimerRef.current);
        speakingTimerRef.current = null;
      }
      queuedAudioEndAtRef.current = 0;
      // Minimal 35ms room-echo decay shield right after Anaïs's audible voice ends
      // (hardware WebRTC AEC already runs in the same AudioContext, so user's first words are never clipped)
      echoTailUntilRef.current = performance.now() + 35;
      modelTurnActiveRef.current = false;
      turnCompletePendingRef.current = false;
      isSpeakingRef.current = false;
      bargeInStreakRef.current = 0;
      setStatusSafe('listening');
    };

    const finishFallbackWhenDrained = () => {
      if (fallbackSourcesRef.current.size === 0 && !finishedRef.current) {
        if (speakingTimerRef.current) {
          window.clearTimeout(speakingTimerRef.current);
        }
        echoTailUntilRef.current = performance.now() + 90;
        speakingTimerRef.current = window.setTimeout(() => {
          if (
            fallbackSourcesRef.current.size === 0 &&
            !modelTurnActiveRef.current &&
            !finishedRef.current
          ) {
            if (!hadUnderrunThisTurnRef.current && underrunCountRef.current > 0) {
              underrunCountRef.current -= 1;
            }
            hadUnderrunThisTurnRef.current = false;
            markAnaisDrained();
          }
        }, 160);
      }
    };

    let hasEverConnected = false;

    const diagnoseBackendAvailability = async (): Promise<string | null> => {
      try {
        const res = await fetch(getApiUrl('/api/health'), {
          method: 'GET',
          cache: 'no-store',
        });
        const contentType = res.headers.get('content-type') || '';
        if (!res.ok || !contentType.includes('application/json')) {
          return "Le serveur vocal temps réel n'est pas actif sur cet hébergement (Vercel ne prend pas en charge les serveurs WebSocket persistants). Déployez l'application complète sur Cloud Run, Render ou Railway, ou configurez VITE_BACKEND_URL.";
        }
        const data = (await res.json()) as { ok?: boolean };
        if (!data?.ok) {
          return "Le serveur vocal temps réel ne répond pas correctement. Vérifiez le déploiement du serveur backend et la variable GEMINI_API_KEY.";
        }
        return null;
      } catch {
        return "Impossible de joindre le serveur vocal temps réel. Vérifiez que le backend Node/WebSocket est démarré et accessible.";
      }
    };

    const scheduleReconnect = (reason?: string) => {
      if (cancelled || finishedRef.current || intentionalCloseRef.current) {
        return;
      }
      if (reconnectTimerRef.current) return;

      if (!navigator.onLine) {
        setErrorMessage(
          'Connexion réseau indisponible. Rétablissez votre connexion puis cliquez sur Reconnecter.'
        );
        setStatusSafe('error');
        return;
      }

      // If the very first WebSocket handshake failed before ever opening, quickly check /api/health
      // so static-only hosts (e.g. Vercel) surface an immediate, clear explanation instead of looping 20s.
      if (!hasEverConnected && reconnectAttemptsRef.current === 0 && !reason) {
        reconnectAttemptsRef.current = 1;
        setStatusSafe('reconnecting');
        diagnoseBackendAvailability()
          .then((diagnostic) => {
            if (cancelled || finishedRef.current || intentionalCloseRef.current) {
              return;
            }
            if (diagnostic) {
              setErrorMessage(diagnostic);
              setStatusSafe('error');
              return;
            }
            reconnectTimerRef.current = window.setTimeout(() => {
              reconnectTimerRef.current = null;
              if (
                !cancelled &&
                !finishedRef.current &&
                !intentionalCloseRef.current
              ) {
                openSocket(true);
              }
            }, RECONNECT_DELAYS_MS[0]);
          })
          .catch(() => {
            if (!cancelled && !finishedRef.current) {
              setErrorMessage(
                'La connexion vocale a été interrompue. Cliquez sur Reconnecter pour reprendre sans perdre vos notes.'
              );
              setStatusSafe('error');
            }
          });
        return;
      }

      const attempt = reconnectAttemptsRef.current;
      if (attempt < RECONNECT_DELAYS_MS.length) {
        const delayMs = RECONNECT_DELAYS_MS[attempt];
        reconnectAttemptsRef.current = attempt + 1;
        setErrorMessage(null);
        setStatusSafe('reconnecting');
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (
            !cancelled &&
            !finishedRef.current &&
            !intentionalCloseRef.current
          ) {
            openSocket(true);
          }
        }, delayMs);
      } else {
        setErrorMessage(
          reason ||
            'La connexion vocale a été interrompue. Cliquez sur Reconnecter pour reprendre sans perdre vos notes.'
        );
        setStatusSafe('error');
      }
    };

    const openSocket = (isReconnect = false) => {
      if (cancelled || finishedRef.current || intentionalCloseRef.current) {
        return;
      }

      // Clear any leftover audio from a previous socket so voices never overlap on reconnect
      stopAnaisPlayback();

      if (wsRef.current) {
        const prev = wsRef.current;
        wsRef.current = null;
        prev.onopen = null;
        prev.onmessage = null;
        prev.onerror = null;
        prev.onclose = null;
        try {
          prev.close(1000, 'Reconnecting');
        } catch {
          // Ignore
        }
      }

      setStatusSafe(isReconnect ? 'reconnecting' : 'connecting');

      const ws = new WebSocket(getLiveWsUrl());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      const enqueuePlaybackChunk = (floatSamples: Float32Array) => {
        const ctx = audioCtxRef.current;
        if (!ctx || floatSamples.length === 0) return;
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        if (isAnaisMutedRef.current) return;

        modelTurnActiveRef.current = true;
        turnCompletePendingRef.current = false;

        // Primary studio path: off-main-thread ring-buffer AudioWorklet (zero chunk seams, zero clicks)
        // Let the worklet's acoustic `playing` event control `isSpeakingRef` so trailing silent chunks
        // arriving just before `turn_complete` never re-lock the participant's microphone.
        const player = playerWorkletRef.current;
        if (player) {
          const chunkMs = (floatSamples.length / 24000) * 1000;
          const nowMs = performance.now();
          const startMs = Math.max(nowMs + 150, queuedAudioEndAtRef.current);
          queuedAudioEndAtRef.current = startMs + chunkMs;

          player.port.postMessage(
            { type: 'push', samples: floatSamples },
            [floatSamples.buffer]
          );

          // Hard failsafe guarantees mic ALWAYS unlocks after queued audio finishes playing
          if (speakingTimerRef.current) {
            window.clearTimeout(speakingTimerRef.current);
          }
          const failsafeMs = Math.max(
            900,
            queuedAudioEndAtRef.current - nowMs + 700
          );
          speakingTimerRef.current = window.setTimeout(() => {
            if (!finishedRef.current && isSpeakingRef.current) {
              markAnaisDrained();
            }
          }, failsafeMs);
          return;
        }

        isSpeakingRef.current = true;
        setStatusSafe('speaking');

        // Fallback path (older browsers without AudioWorklet)
        const rms = computeAudioRms(floatSamples);
        const audioBuffer = ctx.createBuffer(1, floatSamples.length, 24000);
        const channelData = audioBuffer.getChannelData(0);

        const preRollSeconds = computeAdaptivePreRoll(underrunCountRef.current);
        const schedule = computePlaybackSchedule(
          ctx.currentTime,
          nextStartTimeRef.current,
          audioBuffer.duration,
          preRollSeconds
        );
        if (schedule.isRecovery) {
          hadUnderrunThisTurnRef.current = true;
          underrunCountRef.current = Math.min(3, underrunCountRef.current + 1);
          const fadeSamples = Math.min(48, floatSamples.length);
          for (let i = 0; i < fadeSamples; i++) {
            floatSamples[i] *= i / fadeSamples;
          }
        }
        channelData.set(floatSamples);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        if (anaisGainRef.current) {
          source.connect(anaisGainRef.current);
        } else {
          source.connect(ctx.destination);
        }

        source.start(schedule.startAt);
        nextStartTimeRef.current = schedule.nextStartTime;
        fallbackSourcesRef.current.add(source);

        source.onended = () => {
          fallbackSourcesRef.current.delete(source);
          if (turnCompletePendingRef.current) {
            finishFallbackWhenDrained();
          }
        };

        energyRef.current = Math.max(energyRef.current, Math.min(1, rms * 4.8));

        if (speakingTimerRef.current) {
          window.clearTimeout(speakingTimerRef.current);
        }
        const failsafeMs = Math.max(
          900,
          (nextStartTimeRef.current - ctx.currentTime) * 1000 + 650
        );
        speakingTimerRef.current = window.setTimeout(() => {
          if (fallbackSourcesRef.current.size === 0 && !finishedRef.current) {
            markAnaisDrained();
          }
        }, failsafeMs);
      };

      ws.onopen = () => {
        if (cancelled || finishedRef.current || wsRef.current !== ws) return;
        const resumeContext = isReconnect
          ? buildResumeContext(transcriptRef.current, notesRef.current)
          : undefined;

        ws.send(
          JSON.stringify({
            type: 'start',
            engine,
            profile,
            participantName,
            companyName,
            binaryAudio: true,
            ...(resumeContext ? { resumeContext } : {}),
          })
        );
      };

      ws.onmessage = (event) => {
        if (cancelled || finishedRef.current || wsRef.current !== ws) return;

        // Fast binary path: raw 24kHz Int16 PCM directly from server (zero JSON / zero base64)
        if (event.data instanceof ArrayBuffer) {
          enqueuePlaybackChunk(pcm16BufferToFloat32(event.data));
          return;
        }

        try {
          const msg = JSON.parse(event.data as string) as {
            type?: string;
            engineLabel?: string;
            audio?: string;
            text?: string;
            note?: CapturedNote;
            meta?: { contactInfo?: string };
            message?: string;
          };

          if (msg.type === 'pong') return;

          if (msg.type === 'ready') {
            hasEverConnected = true;
            reconnectAttemptsRef.current = 0;
            setStatusSafe('listening');
            setErrorMessage(null);
            if (pendingTextQueueRef.current.length > 0) {
              const queued = [...pendingTextQueueRef.current];
              pendingTextQueueRef.current = [];
              for (const text of queued) {
                ws.send(JSON.stringify({ type: 'text', text }));
              }
            }
          } else if (msg.type === 'audio' && msg.audio) {
            enqueuePlaybackChunk(base64Pcm16ToFloat32(msg.audio));
          } else if (msg.type === 'turn_complete') {
            modelTurnActiveRef.current = false;
            turnCompletePendingRef.current = true;
            if (playerWorkletRef.current) {
              playerWorkletRef.current.port.postMessage({
                type: 'turn_complete',
              });
            } else {
              finishFallbackWhenDrained();
            }
          } else if (msg.type === 'interrupted') {
            stopAnaisPlayback();
            setStatusSafe('listening');
          } else if (msg.type === 'input_transcript' && msg.text) {
            appendTranscript('participant', msg.text);
          } else if (msg.type === 'output_transcript' && msg.text) {
            appendTranscript('anais', msg.text);
          } else if (msg.type === 'note_captured' && msg.note) {
            setCapturedNotes((prev) => {
              const next = [...prev, msg.note!];
              notesRef.current = next;
              return next;
            });
          } else if (msg.type === 'interview_complete_signal') {
            if (msg.meta?.contactInfo) {
              contactInfoRef.current = msg.meta.contactInfo;
            }
            if (confirmTimerRef.current) {
              window.clearTimeout(confirmTimerRef.current);
              confirmTimerRef.current = null;
            }
            const deadline = performance.now() + 6500;
            const waitForGoodbye = () => {
              if (cancelled || finishedRef.current) return;
              const stillTalking =
                isSpeakingRef.current || modelTurnActiveRef.current;
              if (!stillTalking || performance.now() >= deadline) {
                confirmTimerRef.current = null;
                onRequestConfirmationRef.current?.();
                return;
              }
              confirmTimerRef.current = window.setTimeout(waitForGoodbye, 250);
            };
            confirmTimerRef.current = window.setTimeout(waitForGoodbye, 900);
          } else if (msg.type === 'closed') {
            scheduleReconnect();
          } else if (msg.type === 'error') {
            scheduleReconnect(msg.message);
          }
        } catch {
          // Ignore non-JSON frames
        }
      };

      ws.onerror = () => {
        if (
          cancelled ||
          finishedRef.current ||
          intentionalCloseRef.current ||
          wsRef.current !== ws
        ) {
          return;
        }
      };

      ws.onclose = () => {
        if (
          cancelled ||
          finishedRef.current ||
          intentionalCloseRef.current ||
          wsRef.current !== ws
        ) {
          return;
        }
        wsRef.current = null;
        scheduleReconnect();
      };
    };

    openSocketRef.current = openSocket;

    const handleOnline = () => {
      if (
        !cancelled &&
        !finishedRef.current &&
        !intentionalCloseRef.current &&
        (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
      ) {
        reconnectAttemptsRef.current = 0;
        openSocket(true);
      }
    };
    window.addEventListener('online', handleOnline);

    const boot = async () => {
      try {
        // 1. Single native-rate AudioContext (eliminates dual-context clock drift & protects browser AEC)
        const AudioCtxCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const audioCtx = new AudioCtxCtor({ latencyHint: 'interactive' });
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume().catch(() => {});
        }
        audioCtxRef.current = audioCtx;

        const anaisGain = audioCtx.createGain();
        anaisGain.gain.value = isAnaisMutedRef.current ? 0 : 1;
        anaisGainRef.current = anaisGain;

        const recordDest = audioCtx.createMediaStreamDestination();
        anaisGain.connect(audioCtx.destination);
        anaisGain.connect(recordDest);
        nextStartTimeRef.current = audioCtx.currentTime;

        const canUseWorklet =
          typeof AudioWorkletNode !== 'undefined' &&
          Boolean(audioCtx.audioWorklet) &&
          typeof URL.createObjectURL === 'function';

        // 2. Load off-main-thread Ring-Buffer Voice Player Worklet
        if (canUseWorklet) {
          try {
            const playerBlob = new Blob([VOICE_PLAYER_WORKLET_SOURCE], {
              type: 'application/javascript',
            });
            const playerUrl = URL.createObjectURL(playerBlob);
            workletUrlsRef.current.push(playerUrl);
            await audioCtx.audioWorklet.addModule(playerUrl);
            if (cancelled) return;

            const playerNode = new AudioWorkletNode(
              audioCtx,
              'anais-voice-player',
              {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [1],
              }
            );
            playerNode.port.onmessage = (
              ev: MessageEvent<{ type?: string; rms?: number; active?: boolean }>
            ) => {
              if (cancelled || finishedRef.current) return;
              const data = ev.data;
              if (!data) return;
              if (data.type === 'level' && typeof data.rms === 'number') {
                energyRef.current = Math.max(
                  energyRef.current,
                  Math.min(1, data.rms * 4.8)
                );
              } else if (data.type === 'playing') {
                if (data.active) {
                  isSpeakingRef.current = true;
                  setStatusSafe('speaking');
                } else {
                  isSpeakingRef.current = false;
                  echoTailUntilRef.current = performance.now() + 35;
                  setStatusSafe('listening');
                }
              } else if (data.type === 'drained') {
                markAnaisDrained();
              }
            };
            playerNode.connect(anaisGain);
            playerWorkletRef.current = playerNode;
          } catch {
            playerWorkletRef.current = null;
          }
        }

        // 3. Capture User Microphone inside the SAME native AudioContext (perfect hardware AEC alignment)
        try {
          if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
              },
            });

            if (cancelled) {
              stream.getTracks().forEach((t) => t.stop());
              return;
            }

            micStreamRef.current = stream;
            setMicAvailable(true);

            const micSource = audioCtx.createMediaStreamSource(stream);
            // Mix participant mic directly into the session recorder inside the same clock domain
            micSource.connect(recordDest);

            // Gentle 80Hz high-pass removes desk/HVAC rumble without affecting voice timbre
            const highPass = audioCtx.createBiquadFilter();
            highPass.type = 'highpass';
            highPass.frequency.value = 80;
            highPass.Q.value = 0.707;

            const silentSink = audioCtx.createGain();
            silentSink.gain.value = 0;

            micSource.connect(highPass);

            const handleMicFrame16k = (pcm16k: Float32Array) => {
              if (cancelled) return;
              const ws = wsRef.current;
              if (!ws || ws.readyState !== WebSocket.OPEN) return;
              if (ws.bufferedAmount > 128 * 1024) return;

              if (isMicMutedRef.current) {
                prevTransmitGainRef.current = 0;
                bargeInStreakRef.current = 0;
                return;
              }

              // Protect mic ONLY while Anaïs's audible voice is coming out of the speaker (+ 35ms echo tail)
              // and voice isolation is enabled. When Anaïs is listening, stream untouched 1.0 gain PCM so
              // Gemini Live's neural VAD hears the very first syllable with zero gain pumping or step jumps.
              const agentProtected =
                voiceIsolationRef.current &&
                (isSpeakingRef.current ||
                  performance.now() < echoTailUntilRef.current);

              const rms = computeAudioRms(pcm16k);
              const gate = evaluateVoiceFocusGate(
                rms,
                voiceGateRef.current,
                voiceIsolationRef.current,
                agentProtected
              );
              voiceGateRef.current = gate.nextState;

              if (agentProtected) {
                // While Anaïs is audibly speaking, unlock immediately on the first clear user speech frame
                // (64ms) for instant barge-in / fast replies; otherwise apply gentle -13 dB ducking (0.22)
                // instead of hard muting so Gemini's server-side VAD noise floor stays calibrated.
                if (gate.allowTransmit) {
                  bargeInStreakRef.current += 1;
                  setNoiseSuppressedSafe(false);
                  const ramped = applySmoothGainRamp(
                    pcm16k,
                    prevTransmitGainRef.current,
                    1,
                    48
                  );
                  prevTransmitGainRef.current = 1;
                  ws.send(float32ToPcm16Buffer(ramped));
                } else {
                  bargeInStreakRef.current = 0;
                  const keepAliveGain = 0.22;
                  const quietFrame = applySmoothGainRamp(
                    pcm16k,
                    prevTransmitGainRef.current,
                    keepAliveGain,
                    64
                  );
                  prevTransmitGainRef.current = keepAliveGain;
                  ws.send(float32ToPcm16Buffer(quietFrame));
                }
                return;
              }

              bargeInStreakRef.current = 0;
              setNoiseSuppressedSafe(false);
              if (gate.allowTransmit) {
                energyRef.current = Math.max(
                  energyRef.current,
                  gate.normalizedLevel
                );
              }

              // Always stream full 1.0 gain while Anaïs is listening (hardware WebRTC AEC + NS + AGC
              // already clean the signal without distorting soft French syllables or tripping VAD)
              const frameToSend =
                prevTransmitGainRef.current < 0.99
                  ? applySmoothGainRamp(
                      pcm16k,
                      prevTransmitGainRef.current,
                      1,
                      48
                    )
                  : pcm16k;
              prevTransmitGainRef.current = 1;
              ws.send(float32ToPcm16Buffer(frameToSend));
            };

            let micWorkletReady = false;
            if (canUseWorklet) {
              try {
                const micBlob = new Blob([MIC_CAPTURE_WORKLET_SOURCE], {
                  type: 'application/javascript',
                });
                const micUrl = URL.createObjectURL(micBlob);
                workletUrlsRef.current.push(micUrl);
                await audioCtx.audioWorklet.addModule(micUrl);
                if (cancelled) return;

                const micNode = new AudioWorkletNode(
                  audioCtx,
                  'anais-mic-capture',
                  {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    channelCount: 1,
                  }
                );
                micNode.port.onmessage = (ev: MessageEvent<Float32Array>) => {
                  if (ev.data && ev.data.length > 0) {
                    handleMicFrame16k(ev.data);
                  }
                };
                highPass.connect(micNode);
                micNode.connect(silentSink);
                silentSink.connect(audioCtx.destination);
                micWorkletRef.current = micNode;
                micWorkletReady = true;
              } catch {
                micWorkletReady = false;
              }
            }

            if (!micWorkletReady && !cancelled) {
              const processor = audioCtx.createScriptProcessor(2048, 1, 1);
              fallbackMicProcessorRef.current = processor;
              highPass.connect(processor);
              processor.connect(silentSink);
              silentSink.connect(audioCtx.destination);
              processor.onaudioprocess = (event) => {
                const rawInput = event.inputBuffer.getChannelData(0);
                const pcm16k =
                  audioCtx.sampleRate === 16000
                    ? rawInput
                    : downsampleBoxFilter(rawInput, audioCtx.sampleRate, 16000);
                handleMicFrame16k(pcm16k);
              };
            }
          } else {
            setMicAvailable(false);
          }
        } catch {
          setMicAvailable(false);
        }

        // 4. Start Conversation Recorder (captures Anaïs + participant across Chrome, Firefox, and Safari/iOS)
        if (typeof MediaRecorder !== 'undefined') {
          try {
            const candidateMimes = [
              'audio/webm;codecs=opus',
              'audio/webm',
              'audio/mp4',
              'audio/ogg;codecs=opus',
            ];
            const preferredMime =
              typeof MediaRecorder.isTypeSupported === 'function'
                ? candidateMimes.find((m) => MediaRecorder.isTypeSupported(m))
                : undefined;
            const recorder = preferredMime
              ? new MediaRecorder(recordDest.stream, { mimeType: preferredMime })
              : new MediaRecorder(recordDest.stream);
            recorder.ondataavailable = (ev) => {
              if (ev.data && ev.data.size > 0) {
                recordedChunksRef.current.push(ev.data);
              }
            };
            recorder.start(1000);
            mediaRecorderRef.current = recorder;
          } catch {
            // Recording unsupported in this browser
          }
        }

        // 5. Open resilient binary WebSocket to Server Live Bridge (/ws/live)
        openSocket(false);
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(
            err instanceof Error
              ? err.message
              : "Impossible d'initialiser l'audio."
          );
          setStatusSafe('error');
        }
      }
    };

    boot();

    return () => {
      cancelled = true;
      openSocketRef.current = null;
      window.removeEventListener('online', handleOnline);
      window.clearInterval(clockInterval);
      window.clearInterval(pingInterval);
      cleanupResources().catch(() => {});
    };
  }, [
    active,
    engine,
    profile,
    participantName,
    companyName,
    appendTranscript,
    cleanupResources,
    setNoiseSuppressedSafe,
    setStatusSafe,
    stopAnaisPlayback,
  ]);

  return {
    status,
    errorMessage,
    micAvailable,
    isAnaisMuted,
    isMicMuted,
    voiceIsolationEnabled,
    backgroundNoiseSuppressed,
    durationSeconds,
    transcript,
    capturedNotes,
    waveformBars,
    toggleAnaisMute,
    toggleMicMute,
    toggleVoiceIsolation,
    stopAnaisPlayback,
    sendTextMessage,
    reconnect,
    finishSession,
    cancelSession,
  };
}
