import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { BarChart3, Briefcase, Clock, Loader2, VolumeX } from 'lucide-react';
import {
  InterviewProfile,
  InterviewRecord,
  ProviderStatus,
  VoiceEngine,
} from './types/interview';
import { MarqueeBanner } from './components/MarqueeBanner';
import { AnimatedWordText } from './components/AnimatedWordText';
import { LiveCallModal } from './components/LiveCallModal';
import { InterviewSummaryView } from './components/InterviewSummaryView';
import { HistoryView } from './components/HistoryView';
import {
  OfflineIndicator,
  PWAInstallButton,
} from './components/PWAInstallButton';
import { LiveSessionResult } from './hooks/useLiveVoiceSession';
import { useOnlineStatus } from './hooks/usePWA';
import { buildOfflineSummary } from './utils/interviewLogic';
import { getApiUrl } from './utils/apiConfig';
import {
  addPendingDeleteId,
  deleteInterviewOffline,
  getAllOfflineInterviews,
  getOfflineAudioBlob,
  getPendingDeleteIds,
  mergeServerAndOfflineInterviews,
  removePendingDeleteId,
  saveInterviewOffline,
} from './utils/offlineStore';

type ActiveView = 'home' | 'history' | 'summary';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export default function App() {
  const isOnline = useOnlineStatus();

  const [view, setView] = useState<ActiveView>('home');
  const [profile, setProfile] = useState<InterviewProfile>('marketing');
  const voiceEngine: VoiceEngine = 'gemini-3.8-live';
  const [participantName, setParticipantName] = useState('');
  const [companyName, setCompanyName] = useState('');

  const [isCallActive, setIsCallActive] = useState(false);
  const [callSessionKey, setCallSessionKey] = useState(0);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [summaryNotice, setSummaryNotice] = useState<string | null>(null);

  const [interviews, setInterviews] = useState<InterviewRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<InterviewRecord | null>(
    null
  );
  const [, setProviderStatus] = useState<ProviderStatus>({
    geminiLiveAvailable: true,
    aiGatewayEnabled: false,
    aiGatewayLabel: 'Passerelle serveur sécurisée',
    defaultEngine: 'gemini-3.8-live',
  });

  const isSyncingRef = useRef(false);

  // Load provider config + sync backend & offline IndexedDB history
  const loadHistory = useCallback(async () => {
    const localFirst = await getAllOfflineInterviews();
    setInterviews(localFirst);

    if (!navigator.onLine || isSyncingRef.current) return;
    isSyncingRef.current = true;

    try {
      // 1. Replay any pending offline deletions before pulling server list so deleted items never reappear
      const pendingDeletes = getPendingDeleteIds();
      for (const delId of pendingDeletes) {
        try {
          const delRes = await fetch(getApiUrl(`/api/interviews/${encodeURIComponent(delId)}`), {
            method: 'DELETE',
          });
          if (delRes.ok || delRes.status === 404 || delRes.status === 400) {
            removePendingDeleteId(delId);
          }
        } catch {
          // Retry on next online sync
        }
      }

      // 2. Automatically sync any locally saved offline-only interviews back to backend
      const pendingDeleteSet = new Set(getPendingDeleteIds());
      const pendingOffline = localFirst.filter(
        (rec) => rec.syncStatus === 'offline-only' && !pendingDeleteSet.has(rec.id)
      );
      for (const pending of pendingOffline) {
        try {
          const blob = await getOfflineAudioBlob(pending.id);
          const audioBase64 =
            blob && blob.size > 0 && blob.size <= 18 * 1024 * 1024
              ? await blobToBase64(blob)
              : undefined;
          const basePayload = {
            id: pending.id,
            profile: pending.profile,
            voiceEngine: pending.voiceEngine,
            participantName: pending.participantName,
            companyName: pending.companyName,
            contactInfo: pending.contactInfo,
            durationSeconds: pending.durationSeconds,
            transcript: pending.transcript,
            capturedNotes: pending.capturedNotes,
          };
          let syncRes = await fetch(getApiUrl('/api/interviews/complete'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...basePayload, audioBase64 }),
          });
          if (syncRes.status === 413 && audioBase64) {
            syncRes = await fetch(getApiUrl('/api/interviews/complete'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(basePayload),
            });
          }
          if (syncRes.ok) {
            const syncedData = (await syncRes.json()) as { interview: InterviewRecord };
            await saveInterviewOffline(
              {
                ...syncedData.interview,
                hasAudioRecording:
                  syncedData.interview.hasAudioRecording || Boolean(blob && blob.size > 0),
                syncStatus: 'synced',
              },
              blob
            );
          }
        } catch {
          // Keep offline copy intact if backend is temporarily busy
        }
      }

      const [provRes, histRes] = await Promise.all([
        fetch(getApiUrl('/api/config/providers')),
        fetch(getApiUrl('/api/interviews')),
      ]);

      if (provRes.ok) {
        const prov = (await provRes.json()) as ProviderStatus;
        setProviderStatus(prov);
      }

      if (histRes.ok) {
        const data = (await histRes.json()) as { interviews?: InterviewRecord[] };
        if (Array.isArray(data.interviews)) {
          const merged = await mergeServerAndOfflineInterviews(data.interviews);
          setInterviews(merged);
        }
      }
    } catch {
      // Offline or transient failure: keep local IndexedDB records silently
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory, isOnline]);

  // Support ?autostart=1 query param for instant voice interface launch
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      setIsCallActive(true);
    }
  }, []);

  const handleStartCall = (e: React.FormEvent) => {
    e.preventDefault();
    setSummaryNotice(null);
    setCallSessionKey((k) => k + 1);
    setIsCallActive(true);
  };

  const handleRestartCall = () => {
    setSummaryNotice(null);
    setCallSessionKey((k) => k + 1);
    setIsCallActive(true);
  };

  const handleCallFinish = async (result: LiveSessionResult) => {
    setIsCallActive(false);
    setIsGeneratingSummary(true);
    setSummaryNotice(null);

    const recordId = `int_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const createdAt = new Date().toISOString();
    const hasLocalAudio = Boolean(result.audioBlob && result.audioBlob.size > 0);

    // 1. Local-first guarantee: immediately save the real interview & audio to IndexedDB
    // so it can NEVER be lost even if the network drops or summary generation times out.
    const fallbackSummary = buildOfflineSummary(
      profile,
      participantName,
      companyName,
      result.transcript,
      result.capturedNotes
    );

    const localRecord: InterviewRecord = {
      id: recordId,
      profile,
      voiceEngine,
      participantName: participantName.trim() || 'Participant anonyme',
      companyName: companyName.trim() || 'Entreprise confidentielle',
      contactInfo: result.contactInfo,
      createdAt,
      durationSeconds: result.durationSeconds,
      transcript: result.transcript,
      capturedNotes: result.capturedNotes,
      summary: fallbackSummary,
      hasAudioRecording: hasLocalAudio,
      syncStatus: 'offline-only',
    };

    await saveInterviewOffline(localRecord, result.audioBlob);
    setInterviews((prev) => [
      localRecord,
      ...prev.filter((i) => i.id !== recordId),
    ]);

    try {
      let audioBase64: string | undefined;
      // Only upload audio if under ~18MB raw (~24MB base64); larger recordings remain safely in IndexedDB
      if (result.audioBlob && result.audioBlob.size > 0 && result.audioBlob.size <= 18 * 1024 * 1024) {
        try {
          audioBase64 = await blobToBase64(result.audioBlob);
        } catch {
          audioBase64 = undefined;
        }
      }

      if (navigator.onLine) {
        const basePayload = {
          id: recordId,
          profile,
          voiceEngine,
          participantName,
          companyName,
          contactInfo: result.contactInfo,
          durationSeconds: result.durationSeconds,
          transcript: result.transcript,
          capturedNotes: result.capturedNotes,
        };

        try {
          let res = await fetch(getApiUrl('/api/interviews/complete'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...basePayload, audioBase64 }),
          });

          // If request exceeded server body size, retry immediately without audio so AI summary still succeeds
          if (res.status === 413 && audioBase64) {
            res = await fetch(getApiUrl('/api/interviews/complete'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(basePayload),
            });
          }

          if (res.ok) {
            const data = (await res.json()) as { interview: InterviewRecord };
            const syncedRecord: InterviewRecord = {
              ...data.interview,
              hasAudioRecording: data.interview.hasAudioRecording || hasLocalAudio,
              syncStatus: 'synced',
            };
            await saveInterviewOffline(syncedRecord, result.audioBlob);
            setInterviews((prev) => [
              syncedRecord,
              ...prev.filter((i) => i.id !== syncedRecord.id),
            ]);
            setSelectedRecord(syncedRecord);
            setView('summary');
            return;
          }
        } catch {
          // Network/server error -> gracefully show already-persisted local record below
        }
      }

      setSelectedRecord(localRecord);
      setView('summary');
      setSummaryNotice(
        'Entretien enregistré dans votre historique local (synchronisation automatique dès que le serveur répond).'
      );
    } finally {
      setIsGeneratingSummary(false);
    }
  };

  const handleDeleteInterview = async (id: string) => {
    addPendingDeleteId(id);
    await deleteInterviewOffline(id);
    setInterviews((prev) => prev.filter((item) => item.id !== id));
    if (selectedRecord?.id === id) {
      setSelectedRecord(null);
      setView('history');
    }
    if (navigator.onLine) {
      try {
        const res = await fetch(getApiUrl(`/api/interviews/${encodeURIComponent(id)}`), {
          method: 'DELETE',
        });
        if (res.ok || res.status === 404 || res.status === 400) {
          removePendingDeleteId(id);
        }
      } catch {
        // Pending delete remains queued for next online sync
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-[#F5F5F7] flex flex-col">
      {/* Top Bar — Strict 3-Zone Contract matching L'Agence X reference */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#050505]/95 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:gap-8 sm:px-6">
          {/* Zone 1: Brand Logo */}
          <button
            type="button"
            onClick={() => setView('home')}
            className="flex items-center shrink-0 focus-visible:outline-2 focus-visible:outline-white"
            aria-label="Accueil Anaïs · L'Agence X"
          >
            <img
              src="/assets/aistudio/logo_Agence_X_97fe0b2f.png"
              alt="L'Agence X"
              referrerPolicy="no-referrer"
              className="h-6 w-auto object-contain sm:h-7"
            />
          </button>

          {/* Zone 2: Clean single-line navigation links */}
          <nav
            className="flex items-center gap-4 text-xs font-medium sm:gap-6 sm:text-sm"
            aria-label="Navigation principale"
          >
            <button
              type="button"
              onClick={() => setView('home')}
              className={`whitespace-nowrap shrink-0 transition-colors ${
                view === 'home'
                  ? 'text-white underline decoration-[#C49A45] decoration-2 underline-offset-8'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              Entretien
            </button>
            <button
              type="button"
              onClick={() => setView('history')}
              className={`whitespace-nowrap shrink-0 transition-colors ${
                view === 'history' || view === 'summary'
                  ? 'text-white underline decoration-[#C49A45] decoration-2 underline-offset-8'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              Historique ({interviews.length})
            </button>
          </nav>

          {/* Zone 3: Single primary/install utility */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => {
                if (view === 'home') {
                  handleRestartCall();
                } else {
                  setView('home');
                }
              }}
              className="hidden sm:inline-flex rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 whitespace-nowrap shrink-0"
            >
              {view === 'home' ? 'Démarrer' : 'Nouvel entretien'}
            </button>
          </div>
        </div>
      </header>

      {/* Scrolling Manifesto Marquee Banner matching screenshot 4 */}
      <MarqueeBanner />

      {/* Main Content */}
      <main className="flex-1">
        {isGeneratingSummary ? (
          <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-6 text-center">
            <div className="relative flex h-24 w-24 items-center justify-center rounded-full border border-[#C49A45]/40 bg-[#0C0C0E]">
              <Loader2 className="h-8 w-8 animate-spin text-[#D4A853]" />
            </div>
            <h1 className="mt-6 text-2xl font-bold text-white">
              Anaïs rédige votre synthèse automatique…
            </h1>
            <p className="mt-2 text-sm text-zinc-400">
              Identification de vos points bloquants, structuration des réponses et
              préparation du rapport exportable en PDF.
            </p>
          </div>
        ) : view === 'summary' && selectedRecord ? (
          <>
            {summaryNotice && (
              <div className="mx-auto mt-4 max-w-5xl px-6">
                <p className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
                  {summaryNotice}
                </p>
              </div>
            )}
            <InterviewSummaryView
              record={selectedRecord}
              onBackToHistory={() => setView('history')}
              onStartNew={() => {
                setView('home');
                setSelectedRecord(null);
              }}
              onRestartInterview={() => {
                setProfile(selectedRecord.profile);
                setSelectedRecord(null);
                setView('home');
                handleRestartCall();
              }}
            />
          </>
        ) : view === 'history' ? (
          <HistoryView
            interviews={interviews}
            isOnline={isOnline}
            onSelectInterview={(rec) => {
              setSelectedRecord(rec);
              setView('summary');
            }}
            onDeleteInterview={handleDeleteInterview}
            onStartNew={() => setView('home')}
          />
        ) : (
          /* Hero View — Faithful match to L'Agence X reference screenshot 4 */
          <section className="mx-auto grid min-h-[calc(100vh-110px)] max-w-7xl items-center gap-10 px-6 py-6 lg:grid-cols-12 lg:py-8">
            {/* Left Column: Animated Typography, Profile Cards, Engine Selector & CTA */}
            <div className="lg:col-span-7">
              <p className="text-[11px] font-medium tracking-[0.26em] text-zinc-400 uppercase">
                ÉTUDE PME · CÔTE D&apos;IVOIRE
              </p>

              {/* Massive Condensed Word-by-Word Animated Display Headline */}
              <h1
                className="mt-2.5 text-[3.1rem] leading-[0.94] font-extrabold tracking-tight uppercase sm:text-[4.1rem] lg:text-[4.65rem]"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                <span className="block text-white">
                  <AnimatedWordText text="PARLONS DE" delayStart={0.05} stagger={0.07} />
                </span>
                <span className="block text-white">
                  <AnimatedWordText text="VOTRE QUOTIDIEN," delayStart={0.2} stagger={0.07} />
                </span>
                <span className="block text-zinc-400">
                  <AnimatedWordText text="SIMPLEMENT." delayStart={0.38} stagger={0.07} />
                </span>
              </h1>

              {/* Word-by-Word Animated Presentation Text */}
              <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-zinc-400">
                <AnimatedWordText
                  text="Anaïs, l'agente IA de L'Agence X, vous pose quelques questions à voix haute sur ce qui vous fait perdre du temps. Pas de formulaire : une conversation naturelle, en français."
                  delayStart={0.45}
                  stagger={0.022}
                />
              </p>

              {/* Quiet Duration & Anonymity Metadata */}
              <div className="mt-3.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <Clock className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                <span>Environ 10 minutes</span>
                <span aria-hidden="true">·</span>
                <span>réponses anonymes</span>
                <span aria-hidden="true">·</span>
                <span>synthèse automatique &amp; PDF</span>
              </div>

              {/* Setup Form */}
              <form onSubmit={handleStartCall} className="mt-5 max-w-xl space-y-3.5">
                {/* Role Selection Cards matching screenshot 4 */}
                <fieldset>
                  <legend className="sr-only">Choisissez votre fonction</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setProfile('marketing')}
                      aria-pressed={profile === 'marketing'}
                      className={`group flex flex-col items-start rounded-2xl border p-4 text-left transition-all duration-150 focus-visible:outline-2 focus-visible:outline-white ${
                        profile === 'marketing'
                          ? 'border-white/85 bg-[#111114]'
                          : 'border-white/12 bg-[#0A0A0C] hover:border-white/30'
                      }`}
                    >
                      <BarChart3
                        className={`h-4 w-4 ${
                          profile === 'marketing' ? 'text-white' : 'text-zinc-500'
                        }`}
                      />
                      <span className="mt-2.5 text-sm font-semibold text-white">
                        Directeur·rice Marketing
                      </span>
                      <span className="mt-1 text-xs leading-relaxed text-zinc-400">
                        Frictions, procédures, outils &amp; IA, budgets et décision.
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setProfile('dg')}
                      aria-pressed={profile === 'dg'}
                      className={`group flex flex-col items-start rounded-2xl border p-4 text-left transition-all duration-150 focus-visible:outline-2 focus-visible:outline-white ${
                        profile === 'dg'
                          ? 'border-white/85 bg-[#111114]'
                          : 'border-white/12 bg-[#0A0A0C] hover:border-white/30'
                      }`}
                    >
                      <Briefcase
                        className={`h-4 w-4 ${
                          profile === 'dg' ? 'text-white' : 'text-zinc-500'
                        }`}
                      />
                      <span className="mt-2.5 text-sm font-semibold text-white">
                        Directeur·rice Général·e
                      </span>
                      <span className="mt-1 text-xs leading-relaxed text-zinc-400">
                        Pilotage, procédures, gouvernance IA, sécurité et ROI.
                      </span>
                    </button>
                  </div>
                </fieldset>

                {/* Optional First Name & Company Inputs matching screenshot 4 */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="participant-name" className="sr-only">
                      Votre prénom (facultatif)
                    </label>
                    <input
                      id="participant-name"
                      type="text"
                      maxLength={100}
                      value={participantName}
                      onChange={(e) => setParticipantName(e.target.value)}
                      placeholder="Votre prénom (facultatif)"
                      className="w-full rounded-xl border border-white/12 bg-[#0A0A0C] px-4 py-3 text-sm text-white placeholder:text-zinc-500 transition-colors focus:border-white/45 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="company-name" className="sr-only">
                      Entreprise (facultatif)
                    </label>
                    <input
                      id="company-name"
                      type="text"
                      maxLength={120}
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="Entreprise (facultatif)"
                      className="w-full rounded-xl border border-white/12 bg-[#0A0A0C] px-4 py-3 text-sm text-white placeholder:text-zinc-500 transition-colors focus:border-white/45 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Primary White Pill CTA matching screenshot 4 */}
                <div className="pt-2">
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center rounded-full bg-white px-8 py-3.5 text-sm font-semibold text-black transition-transform duration-150 hover:bg-zinc-200 active:scale-[0.98] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                  >
                    Parler avec Anaïs
                  </button>
                </div>

                <div className="space-y-2 pt-0.5">
                  <p className="flex items-start gap-2 text-xs leading-relaxed text-zinc-300">
                    <VolumeX
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#D4A853]"
                      aria-hidden="true"
                    />
                    <span>
                      Pour une conversation fluide et sans interruption, il est
                      préférable de vous installer dans un endroit calme et sans
                      bruit.
                    </span>
                  </p>
                  <p className="text-xs text-zinc-500">
                    La conversation est enregistrée pour l&apos;analyse de l&apos;étude.
                    Votre micro sera demandé.
                  </p>
                </div>
              </form>
            </div>

            {/* Right Column: Anaïs Portrait with Concentric Ring & Floating Label matching screenshot 4 */}
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col items-center justify-center lg:col-span-5"
            >
              <div
                className="relative flex h-[340px] w-[340px] items-center justify-center sm:h-[430px] sm:w-[430px]"
                data-testid="anais-signal-portrait"
              >
                {/* Radiating Signal Wave Rings */}
                <span
                  className="animate-anais-signal-wave pointer-events-none absolute inset-2 rounded-full border border-[#D4A853]/50"
                  style={{ animationDelay: '0s' }}
                  aria-hidden="true"
                />
                <span
                  className="animate-anais-signal-wave pointer-events-none absolute inset-2 rounded-full border border-emerald-400/40"
                  style={{ animationDelay: '1.3s' }}
                  aria-hidden="true"
                />
                <span
                  className="animate-anais-signal-wave pointer-events-none absolute inset-2 rounded-full border border-[#D4A853]/35"
                  style={{ animationDelay: '2.6s' }}
                  aria-hidden="true"
                />

                {/* Soft Breathing Radial Signal Halo */}
                <div
                  className="animate-anais-signal-halo pointer-events-none absolute inset-5 rounded-full bg-[radial-gradient(circle,rgba(212,168,83,0.16)_0%,rgba(16,185,129,0.08)_48%,transparent_72%)]"
                  aria-hidden="true"
                />

                {/* Outer Concentric Thin Ring */}
                <div
                  className="pointer-events-none absolute inset-0 rounded-full border border-white/12"
                  aria-hidden="true"
                />

                {/* Inner Portrait Container with Crisp White Ring */}
                <div className="relative z-10 h-[265px] w-[265px] overflow-hidden rounded-full border-2 border-white/85 bg-[#0B2D33] shadow-2xl sm:h-[330px] sm:w-[330px]">
                  <img
                    src="/assets/aistudio/image_e3a777aa.png"
                    alt="Portrait d'Anaïs, agente IA de L'Agence X"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover object-top"
                  />
                </div>

                {/* Floating Bottom Center Identity Label matching screenshot 4 */}
                <div className="absolute bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/15 bg-[#0D0D10]/95 px-6 py-2.5 text-center shadow-xl backdrop-blur-md sm:bottom-8">
                  <div className="flex items-center justify-center gap-2">
                    <span className="relative flex h-2 w-2" aria-hidden="true">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                    </span>
                    <p
                      className="text-sm font-bold tracking-[0.12em] text-white uppercase"
                      style={{ fontFamily: 'var(--font-display)' }}
                    >
                      ANAÏS
                    </p>
                  </div>
                  <p className="text-[11px] text-zinc-400 whitespace-nowrap">
                    Agente IA · L&apos;Agence X
                  </p>
                </div>
              </div>
            </motion.div>
          </section>
        )}
      </main>

      {/* Live Voice Call Modal (AX LIVE · EN DIRECT) */}
      {isCallActive && (
        <LiveCallModal
          key={callSessionKey}
          profile={profile}
          engine={voiceEngine}
          participantName={participantName}
          companyName={companyName}
          onFinish={handleCallFinish}
          onRestart={handleRestartCall}
          onCancel={() => setIsCallActive(false)}
        />
      )}

      {/* Subtle Offline Connectivity Indicator */}
      <OfflineIndicator />
    </div>
  );
}
