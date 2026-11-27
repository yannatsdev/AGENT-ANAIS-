import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Ban,
  Check,
  FileText,
  Mic,
  MicOff,
  PhoneOff,
  RotateCcw,
  Send,
  ShieldCheck,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  InterviewProfile,
  VoiceEngine,
} from '../types/interview';
import {
  LiveSessionResult,
  useLiveVoiceSession,
} from '../hooks/useLiveVoiceSession';
import {
  calculateThemeProgress,
  formatDuration,
} from '../utils/interviewLogic';
import { getSectionsForProfile } from '../data/questionnaires';

interface LiveCallModalProps {
  profile: InterviewProfile;
  engine: VoiceEngine;
  participantName: string;
  companyName: string;
  onFinish: (result: LiveSessionResult) => void;
  onRestart: () => void;
  onCancel: () => void;
}

export const LiveCallModal: React.FC<LiveCallModalProps> = ({
  profile,
  engine,
  participantName,
  companyName,
  onFinish,
  onRestart,
  onCancel,
}) => {
  const [showNotesDrawer, setShowNotesDrawer] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [showEndConfirmation, setShowEndConfirmation] = useState(false);
  const [showCancelConfirmation, setShowCancelConfirmation] = useState(false);
  const [confirmPromptSource, setConfirmPromptSource] = useState<'user' | 'anais'>('user');

  const session = useLiveVoiceSession({
    profile,
    engine,
    participantName,
    companyName,
    active: true,
    onRequestConfirmation: () => {
      setConfirmPromptSource('anais');
      setShowEndConfirmation(true);
    },
  });

  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const notesScrollRef = useRef<HTMLDivElement | null>(null);

  const sections = getSectionsForProfile(profile);
  const progress = calculateThemeProgress(
    profile,
    session.capturedNotes,
    session.transcript
  );

  useEffect(() => {
    if (showNotesDrawer && transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop =
        transcriptScrollRef.current.scrollHeight;
    }
  }, [showNotesDrawer, session.transcript]);

  useEffect(() => {
    if (showNotesDrawer && notesScrollRef.current) {
      notesScrollRef.current.scrollTop = notesScrollRef.current.scrollHeight;
    }
  }, [showNotesDrawer, session.capturedNotes]);

  // Opens confirmation dialog before Anaïs generates the summary
  const handleRequestFinish = () => {
    if (isFinalizing) return;
    session.stopAnaisPlayback();
    setConfirmPromptSource('user');
    setShowEndConfirmation(true);
  };

  // User confirms -> finalize recording and let Anaïs write the summary
  const handleConfirmFinish = async () => {
    if (isFinalizing) return;
    setShowEndConfirmation(false);
    setIsFinalizing(true);
    const result = await session.finishSession();
    onFinish(result);
  };

  // User cancels -> resume the ongoing live interview without losing context
  const handleResumeInterview = () => {
    setShowEndConfirmation(false);
    if (confirmPromptSource === 'anais') {
      session.sendTextMessage(
        "Je préfère continuer l'entretien et reprendre un point avec vous avant la synthèse."
      );
    }
  };

  // Restart interview completely from scratch
  const handleRestartInterview = async () => {
    if (isFinalizing) return;
    setShowEndConfirmation(false);
    setShowCancelConfirmation(false);
    await session.cancelSession();
    onRestart();
  };

  // Immediately cancel & discard the conversation without saving or generating a summary
  const handleConfirmCancel = async () => {
    if (isFinalizing) return;
    setShowEndConfirmation(false);
    setShowCancelConfirmation(false);
    await session.cancelSession();
    onCancel();
  };

  // Ask confirmation before discarding an active conversation, or close immediately if just opened
  const handleRequestCancel = () => {
    if (isFinalizing) return;
    session.stopAnaisPlayback();
    const hasConversationData =
      session.transcript.length > 0 ||
      session.capturedNotes.length > 0 ||
      session.durationSeconds >= 5;
    if (!hasConversationData) {
      void handleConfirmCancel();
      return;
    }
    setShowEndConfirmation(false);
    setShowCancelConfirmation(true);
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textDraft.trim()) return;
    session.sendTextMessage(textDraft);
    setTextDraft('');
  };

  const statusLabel = (() => {
    if (isFinalizing) return 'Génération de votre synthèse…';
    if (showCancelConfirmation) return 'Annulation de la conversation';
    if (showEndConfirmation) return 'Confirmation avant synthèse';
    if (session.status === 'connecting') return 'Connexion…';
    if (session.status === 'reconnecting') return 'Reconnexion en cours…';
    if (session.status === 'error') return 'Connexion vocale indisponible';
    if (session.isAnaisMuted) return "Son d'Anaïs coupé";
    if (session.status === 'speaking') return 'Anaïs parle…';
    if (session.isMicMuted) return 'Micro coupé';
    return 'Anaïs vous écoute…';
  })();

  const isAnaisActivelySpeaking =
    session.status === 'speaking' && !session.isAnaisMuted;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/85 p-3 sm:p-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Appel en direct avec Anaïs de L'Agence X"
      data-testid="live-call-modal"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="relative flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-y-auto rounded-3xl border border-white/10 bg-[#0C0C0E] shadow-2xl"
      >
        {/* Top bar matching screenshot 2: AX LIVE · EN DIRECT + close button */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-white/5 bg-[#0C0C0E]/95 px-4 pt-4 pb-3 backdrop-blur-md sm:px-6 sm:pt-5">
          <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                session.status === 'listening' || session.status === 'speaking'
                  ? 'bg-emerald-400'
                  : session.status === 'reconnecting'
                    ? 'bg-amber-400 animate-pulse'
                    : session.status === 'error'
                      ? 'bg-red-500'
                      : 'bg-zinc-500'
              }`}
              aria-hidden="true"
            />
            <span className="whitespace-nowrap text-[11px] sm:text-xs font-semibold tracking-[0.18em] sm:tracking-[0.22em] text-zinc-200 uppercase">
              AX LIVE<span className="hidden sm:inline"> · EN DIRECT</span>
            </span>
            <span className="shrink-0 text-xs text-zinc-500 font-mono tabular-nums">
              {formatDuration(session.durationSeconds)}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={handleRestartInterview}
              disabled={isFinalizing}
              aria-label="Recommencer l'entretien"
              className="inline-flex h-9 w-9 sm:h-10 sm:w-auto items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/5 sm:px-3.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Recommencer</span>
            </button>
            <button
              type="button"
              onClick={handleRequestCancel}
              disabled={isFinalizing}
              aria-label="Annuler la conversation"
              className="inline-flex h-9 sm:h-10 items-center gap-1.5 rounded-full border border-red-500/25 bg-red-500/10 px-3 sm:px-3.5 text-xs font-medium text-red-200 transition-colors hover:border-red-500/45 hover:bg-red-500/20 hover:text-white disabled:opacity-50 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-white"
            >
              <Ban className="h-3.5 w-3.5" />
              <span>Annuler</span>
            </button>
            <button
              type="button"
              onClick={handleRequestCancel}
              disabled={isFinalizing}
              aria-label="Fermer l'appel"
              className="flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-full border border-white/15 bg-white/5 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Center stage matching screenshot 2: concentric golden speaking ring + teal avatar + golden equalizer */}
        <div className="flex flex-col items-center px-4 pt-4 pb-5 sm:px-6 sm:pt-5 sm:pb-6">
          <div
            className={`relative flex items-center justify-center transition-all duration-200 ${
              showNotesDrawer
                ? 'h-44 w-44 sm:h-56 sm:w-56'
                : 'h-56 w-56 sm:h-72 sm:w-72'
            }`}
          >
            {/* Outer subtle halo when speaking */}
            <motion.div
              animate={
                isAnaisActivelySpeaking
                  ? { scale: [1, 1.07, 1], opacity: [0.35, 0.7, 0.35] }
                  : { scale: 1, opacity: 0.2 }
              }
              transition={{
                duration: 1.6,
                repeat: isAnaisActivelySpeaking ? Infinity : 0,
                ease: 'easeInOut',
              }}
              className="pointer-events-none absolute inset-0 rounded-full border border-[#C49A45]/40"
            />

            {/* Primary Gold Ring (exact reference visual) */}
            <motion.div
              animate={
                isAnaisActivelySpeaking
                  ? { scale: [1, 1.035, 0.99, 1.025, 1] }
                  : { scale: 1 }
              }
              transition={{
                duration: 1.25,
                repeat: isAnaisActivelySpeaking ? Infinity : 0,
                ease: 'easeInOut',
              }}
              className={`pointer-events-none absolute inset-3 rounded-full border-[1.5px] transition-colors duration-300 ${
                session.isAnaisMuted
                  ? 'border-zinc-700'
                  : isAnaisActivelySpeaking
                    ? 'border-[#D4A853] shadow-[0_0_32px_rgba(196,154,69,0.22)]'
                    : 'border-[#9A7435]/75'
              }`}
            />

            {/* Anaïs Portrait with Emerald/Teal Ring */}
            <div
              className={`relative overflow-hidden rounded-full border-2 border-[#10B981] bg-[#0B2D33] shadow-xl transition-all duration-200 ${
                showNotesDrawer
                  ? 'h-28 w-28 sm:h-36 sm:w-36'
                  : 'h-36 w-36 sm:h-44 sm:w-44'
              }`}
            >
              <img
                src="/assets/aistudio/image_e3a777aa.png"
                alt="Anaïs, agente IA de L'Agence X"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover object-top"
              />
              {session.isAnaisMuted && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                  <VolumeX className="h-8 w-8 text-white/90" />
                </div>
              )}
            </div>
          </div>

          {/* Warm Gold Vertical Bar Equalizer matching screenshot 2 */}
          <div
            className="mt-2 flex h-12 items-end justify-center gap-1.5"
            aria-hidden="true"
            data-testid="voice-equalizer"
          >
            {session.waveformBars.map((level, index) => {
              const heightPx = Math.round(
                8 + (session.isAnaisMuted ? 0.12 : level) * 34
              );
              return (
                <span
                  key={index}
                  style={{
                    height: `${heightPx}px`,
                    opacity: session.isAnaisMuted ? 0.3 : 0.65 + level * 0.35,
                  }}
                  className="w-1.5 rounded-full bg-gradient-to-t from-[#8A6629] to-[#D4A853] transition-all duration-75"
                />
              );
            })}
          </div>

          {/* Status Text */}
          <p
            className="mt-5 text-lg font-semibold tracking-tight text-white"
            data-testid="call-status-label"
          >
            {statusLabel}
          </p>

          {/* Subtle contextual cue: voice focus / mic status / error */}
          <div className="mt-1.5 flex flex-col sm:flex-row sm:flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-xs text-zinc-400">
            <span>
              {profile === 'marketing'
                ? 'Parcours Directeur·rice Marketing'
                : 'Parcours Directeur·rice Général·e'}
            </span>
            <span aria-hidden="true" className="hidden sm:inline">
              ·
            </span>
            <span>
              {session.voiceIsolationEnabled
                ? session.backgroundNoiseSuppressed
                  ? 'Bruit de fond atténué · Voix principale isolée'
                  : 'Isolation vocale active'
                : 'Isolation vocale désactivée'}
            </span>
          </div>

          {session.errorMessage && (
            <div className="mt-3 flex max-w-md flex-col items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-center text-xs text-amber-200">
              <span>{session.errorMessage}</span>
              <button
                type="button"
                onClick={session.reconnect}
                className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-white"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reconnecter</span>
              </button>
            </div>
          )}

          {!session.micAvailable && (
            <p className="mt-2 text-xs text-zinc-400">
              Microphone non détecté : vous pouvez répondre par écrit ci-dessous.
            </p>
          )}

          {/* Primary Call Controls: Mute Anaïs + Red Hang Up + Mute Mic */}
          <div className="mt-5 flex items-center justify-center gap-2.5 sm:mt-6 sm:gap-5">
            {/* Mute Anaïs Button (couper le son d'Anaïs à tout moment) */}
            <button
              type="button"
              onClick={session.toggleAnaisMute}
              aria-pressed={session.isAnaisMuted}
              aria-label={
                session.isAnaisMuted
                  ? "Rétablir le son d'Anaïs"
                  : "Couper le son d'Anaïs"
              }
              className={`flex h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-white sm:h-12 sm:gap-2 sm:px-4 ${
                session.isAnaisMuted
                  ? 'border-amber-400/50 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
                  : 'border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10'
              }`}
            >
              {session.isAnaisMuted ? (
                <>
                  <VolumeX className="h-4 w-4" />
                  <span>Anaïs coupée</span>
                </>
              ) : (
                <>
                  <Volume2 className="h-4 w-4" />
                  <span>Couper Anaïs</span>
                </>
              )}
            </button>

            {/* Primary Red Hang-Up Button (opens confirmation before writing summary) */}
            <button
              type="button"
              onClick={handleRequestFinish}
              disabled={isFinalizing}
              aria-label="Terminer l'entretien et confirmer la synthèse"
              className="flex h-13 w-13 shrink-0 items-center justify-center rounded-full bg-[#DC2626] text-white shadow-lg shadow-red-900/40 transition-transform hover:scale-105 hover:bg-[#EF4444] active:scale-95 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:h-14 sm:w-14"
            >
              <PhoneOff className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>

            {/* Mute User Microphone Button */}
            <button
              type="button"
              onClick={session.toggleMicMute}
              aria-pressed={session.isMicMuted}
              aria-label={
                session.isMicMuted ? 'Réactiver mon micro' : 'Couper mon micro'
              }
              className={`flex h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-white sm:h-12 sm:gap-2 sm:px-4 ${
                session.isMicMuted
                  ? 'border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25'
                  : 'border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10'
              }`}
            >
              {session.isMicMuted ? (
                <>
                  <MicOff className="h-4 w-4" />
                  <span>Micro coupé</span>
                </>
              ) : (
                <>
                  <Mic className="h-4 w-4" />
                  <span>Micro actif</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Bottom Utility Bar: Voice Isolation toggle + Live Notes & Transcript Drawer */}
        <div className="border-t border-white/10 bg-[#08080A] px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={session.toggleVoiceIsolation}
              aria-pressed={session.voiceIsolationEnabled}
              className="flex items-center gap-2 text-xs text-zinc-300 transition-colors hover:text-white"
            >
              <ShieldCheck
                className={`h-4 w-4 ${
                  session.voiceIsolationEnabled
                    ? 'text-emerald-400'
                    : 'text-zinc-600'
                }`}
              />
              <span>
                Isolation vocale :{' '}
                <strong className="font-medium text-white">
                  {session.voiceIsolationEnabled ? 'Activée' : 'Désactivée'}
                </strong>
              </span>
            </button>

            <div className="flex items-center gap-4">
              <span className="text-xs text-zinc-400 font-mono tabular-nums">
                {session.capturedNotes.length} note
                {session.capturedNotes.length > 1 ? 's' : ''} · {progress.percent}%
              </span>
              <button
                type="button"
                onClick={() => setShowNotesDrawer((v) => !v)}
                aria-expanded={showNotesDrawer}
                className="flex items-center gap-1.5 text-xs font-medium text-zinc-200 underline-offset-4 hover:text-white hover:underline"
              >
                <FileText className="h-3.5 w-3.5" />
                <span>
                  {showNotesDrawer
                    ? 'Masquer le suivi'
                    : 'Notes & réponse écrite'}
                </span>
              </button>
            </div>
          </div>

          {showNotesDrawer && (
            <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
              {/* Theme progression strip */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {sections.map((sec) => {
                  const done = progress.completedSections.includes(sec.code);
                  const isCurrent = progress.activeSectionCode === sec.code;
                  const firstQ = sec.questionIds[0];
                  const lastQ = sec.questionIds[sec.questionIds.length - 1];
                  const rangeLabel =
                    firstQ && lastQ && firstQ !== lastQ
                      ? `${firstQ}–${lastQ}`
                      : firstQ || '';
                  return (
                    <span
                      key={sec.code}
                      title={sec.focusSummary}
                      className={`transition-colors ${
                        done
                          ? 'text-emerald-400 font-medium'
                          : isCurrent
                            ? 'text-[#D4A853] font-medium'
                            : 'text-zinc-500'
                      }`}
                    >
                      {sec.code}. {sec.title}{' '}
                      <span className="font-mono text-[10px] opacity-75">
                        ({rangeLabel})
                      </span>
                      {sec.code !== sections[sections.length - 1].code && (
                        <span className="ml-2 text-zinc-700">/</span>
                      )}
                    </span>
                  );
                })}
              </div>

              {/* Live Transcript & Notes */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div
                  ref={transcriptScrollRef}
                  className="max-h-36 overflow-y-auto rounded-xl border border-white/10 bg-[#0D0D10] p-3"
                >
                  <p className="mb-2 text-[11px] font-medium text-zinc-400">
                    Transcription en direct
                  </p>
                  {session.transcript.length === 0 ? (
                    <p className="text-xs text-zinc-500">
                      La conversation s&apos;affiche ici au fil de l&apos;échange.
                    </p>
                  ) : (
                    <div className="space-y-2 text-xs">
                      {session.transcript.map((item) => (
                        <div key={item.id} className="leading-relaxed">
                          <span
                            className={`font-semibold ${
                              item.speaker === 'anais'
                                ? 'text-[#D4A853]'
                                : 'text-white'
                            }`}
                          >
                            {item.speaker === 'anais'
                              ? 'Anaïs'
                              : participantName || 'Vous'}{' '}
                            :
                          </span>{' '}
                          <span className="text-zinc-300">{item.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div
                  ref={notesScrollRef}
                  className="max-h-36 overflow-y-auto rounded-xl border border-white/10 bg-[#0D0D10] p-3"
                >
                  <p className="mb-2 text-[11px] font-medium text-zinc-400">
                    Notes enregistrées par Anaïs
                  </p>
                  {session.capturedNotes.length === 0 ? (
                    <p className="text-xs text-zinc-500">
                      Anaïs consigne automatiquement vos réponses clés en temps réel.
                    </p>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {session.capturedNotes.map((n, idx) => (
                        <li key={`${n.questionId}-${idx}`} className="text-zinc-300">
                          <span className="font-mono text-[#D4A853]">
                            {n.questionId}
                          </span>{' '}
                          · <strong className="text-white">{n.topic}</strong> :{' '}
                          {n.answer}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Optional Text Reply Bar (great when mic is muted/noisy or for quick replies) */}
              <form onSubmit={handleSendText} className="flex items-center gap-2">
                <label htmlFor="live-text-reply" className="sr-only">
                  Envoyer une réponse écrite à Anaïs
                </label>
                <input
                  id="live-text-reply"
                  type="text"
                  maxLength={1000}
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  placeholder="Répondre par écrit à Anaïs (si vous êtes dans un lieu bruyant)…"
                  className="flex-1 rounded-xl border border-white/15 bg-[#121216] px-3.5 py-2.5 text-xs text-white placeholder:text-zinc-500 focus:border-white/40 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!textDraft.trim() || isFinalizing}
                  aria-label="Envoyer la réponse écrite"
                  className="flex h-9 items-center gap-1.5 rounded-xl bg-white px-4 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-45 whitespace-nowrap"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Envoyer</span>
                </button>
              </form>
            </div>
          )}
        </div>
        {/* Confirmation Overlay Before Anaïs Writes the Summary */}
        {showEndConfirmation && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 p-5 backdrop-blur-md"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-summary-title"
            data-testid="end-confirmation-dialog"
          >
            <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#121216] p-6 text-center shadow-2xl">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[#C49A45]/45 bg-[#C49A45]/10 text-[#D4A853]">
                <Check className="h-5 w-5" />
              </div>

              <h2
                id="confirm-summary-title"
                className="mt-4 text-lg font-bold text-white"
              >
                Confirmer et rédiger la synthèse ?
              </h2>

              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                Anaïs s&apos;apprête à analyser votre échange pour rédiger la
                synthèse de vos points bloquants. Est-ce bon pour vous, ou
                souhaitez-vous annuler et reprendre la conversation ?
              </p>

              <div className="mt-6 flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={handleConfirmFinish}
                  className="w-full rounded-full bg-white px-5 py-3 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-white"
                >
                  Confirmer et rédiger la synthèse
                </button>

                <button
                  type="button"
                  onClick={handleResumeInterview}
                  className="w-full rounded-full border border-white/20 bg-white/5 px-5 py-2.5 text-xs font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
                >
                  Reprendre l&apos;entretien
                </button>

                <button
                  type="button"
                  onClick={handleRestartInterview}
                  className="mt-1 inline-flex items-center justify-center gap-1.5 py-1.5 text-xs text-zinc-400 transition-colors hover:text-white"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Recommencer depuis le début</span>
                </button>

                <button
                  type="button"
                  onClick={handleConfirmCancel}
                  className="inline-flex items-center justify-center gap-1.5 py-1.5 text-xs text-red-400 transition-colors hover:text-red-300"
                >
                  <Ban className="h-3.5 w-3.5" />
                  <span>Annuler la conversation (sans enregistrer)</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cancel Conversation Confirmation Overlay */}
        {showCancelConfirmation && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 p-5 backdrop-blur-md"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cancel-conversation-title"
            data-testid="cancel-confirmation-dialog"
          >
            <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#121216] p-6 text-center shadow-2xl">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-red-500/35 bg-red-500/10 text-red-400">
                <Ban className="h-5 w-5" />
              </div>

              <h2
                id="cancel-conversation-title"
                className="mt-4 text-lg font-bold text-white"
              >
                Annuler la conversation ?
              </h2>

              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                L&apos;entretien en cours et son enregistrement audio seront
                annulés sans rédiger de synthèse ni sauvegarder dans
                l&apos;historique.
              </p>

              <div className="mt-6 flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={handleConfirmCancel}
                  className="w-full rounded-full bg-[#DC2626] px-5 py-3 text-xs font-semibold text-white transition-colors hover:bg-[#EF4444] focus-visible:outline-2 focus-visible:outline-white"
                >
                  Oui, annuler la conversation
                </button>

                <button
                  type="button"
                  onClick={() => setShowCancelConfirmation(false)}
                  className="w-full rounded-full border border-white/20 bg-white/5 px-5 py-2.5 text-xs font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
                >
                  Continuer la conversation
                </button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
};
