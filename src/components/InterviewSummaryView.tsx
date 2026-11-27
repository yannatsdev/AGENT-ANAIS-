import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Download,
  FileText,
  Headphones,
  MessageSquare,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { InterviewRecord } from '../types/interview';
import { formatDuration } from '../utils/interviewLogic';
import { exportInterviewToPdf } from '../utils/pdfExport';
import { getOfflineAudioUrl } from '../utils/offlineStore';

interface InterviewSummaryViewProps {
  record: InterviewRecord;
  onBackToHistory: () => void;
  onStartNew: () => void;
  onRestartInterview?: () => void;
}

export const InterviewSummaryView: React.FC<InterviewSummaryViewProps> = ({
  record,
  onBackToHistory,
  onStartNew,
  onRestartInterview,
}) => {
  const [pdfFeedback, setPdfFeedback] = useState<string | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(record.audioUrl || null);
  const [audioFallbackTried, setAudioFallbackTried] = useState<boolean>(false);
  const [showTranscript, setShowTranscript] = useState<boolean>(true);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    const revokeCurrent = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };

    const resolveAudio = async () => {
      revokeCurrent();
      setAudioSrc(null);
      setAudioFallbackTried(false);
      if (record.audioUrl && navigator.onLine) {
        if (active) setAudioSrc(record.audioUrl);
        return;
      }
      const localUrl = await getOfflineAudioUrl(record.id);
      if (active && localUrl) {
        objectUrlRef.current = localUrl;
        setAudioSrc(localUrl);
      } else if (active && record.audioUrl) {
        setAudioSrc(record.audioUrl);
      } else if (active) {
        setAudioSrc(null);
      }
    };

    resolveAudio();

    return () => {
      active = false;
      revokeCurrent();
    };
  }, [record.id, record.audioUrl]);

  const handleAudioError = async () => {
    if (audioFallbackTried) {
      setAudioSrc(null);
      return;
    }
    setAudioFallbackTried(true);
    const localUrl = await getOfflineAudioUrl(record.id);
    if (localUrl) {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = localUrl;
      setAudioSrc(localUrl);
    } else {
      setAudioSrc(null);
    }
  };

  const handleExportPdf = () => {
    const filename = exportInterviewToPdf(record);
    setPdfFeedback(`PDF exporté (${filename})`);
    window.setTimeout(() => setPdfFeedback(null), 4500);
  };

  const roleLabel =
    record.profile === 'marketing'
      ? 'Directeur·rice Marketing'
      : 'Directeur·rice Général·e';

  const criticalCount = record.summary.keyPainPoints.filter(
    (p) => p.severity === 'Critique'
  ).length;

  return (
    <section
      className="mx-auto w-full max-w-5xl px-6 py-10"
      aria-label="Synthèse automatique de l'entretien"
    >
      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-6">
        <button
          type="button"
          onClick={onBackToHistory}
          className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-white whitespace-nowrap"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Retour à l&apos;historique</span>
        </button>

        <div className="flex flex-wrap items-center gap-3">
          {onRestartInterview && (
            <button
              type="button"
              onClick={onRestartInterview}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/10 hover:text-white whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Recommencer l&apos;entretien</span>
            </button>
          )}
          <button
            type="button"
            onClick={onStartNew}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/10 hover:text-white whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Accueil</span>
          </button>

          <button
            type="button"
            onClick={handleExportPdf}
            className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 whitespace-nowrap"
          >
            {pdfFeedback ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-700" />
                <span>PDF téléchargé</span>
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                <span>Exporter en PDF</span>
              </>
            )}
          </button>
        </div>
      </div>

      {pdfFeedback && (
        <p
          role="status"
          className="mt-3 text-xs text-emerald-400"
        >
          {pdfFeedback}
        </p>
      )}

      {/* Header & Executive Summary */}
      <div className="mt-8">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-zinc-400">
          <span>{roleLabel}</span>
          <span aria-hidden="true">·</span>
          <span>{record.companyName}</span>
          <span aria-hidden="true">·</span>
          <span>{record.participantName}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            {formatDuration(record.durationSeconds)}
          </span>
          {record.syncStatus !== 'synced' && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-amber-400">Sauvegardé hors ligne</span>
            </>
          )}
        </div>

        <h1
          className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-white sm:text-4xl"
          style={{ textWrap: 'balance' }}
        >
          {record.summary.headline}
        </h1>

        <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-zinc-300">
          {record.summary.executiveSummary}
        </p>
      </div>

      {/* Key Metrics Strip */}
      <div className="mt-8 grid gap-4 border-y border-white/10 py-6 sm:grid-cols-3">
        <div>
          <p className="text-xs text-zinc-500">Temps ou charge estimée</p>
          <p className="mt-1 text-base font-semibold text-white">
            {record.summary.timeLostEstimate}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Niveau de structuration</p>
          <p className="mt-1 text-base font-semibold text-white">
            {record.summary.maturityLevel}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Points bloquants identifiés</p>
          <p className="mt-1 text-base font-semibold text-white font-mono tabular-nums">
            {record.summary.keyPainPoints.length} identifié
            {record.summary.keyPainPoints.length > 1 ? 's' : ''} ({criticalCount}{' '}
            critique{criticalCount > 1 ? 's' : ''})
          </p>
        </div>
      </div>

      {/* Audio Recording Playback (when captured) */}
      {audioSrc && (
        <div className="mt-8 flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#0C0C0E] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#C49A45]/40 bg-[#C49A45]/10 text-[#D4A853]">
              <Headphones className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">
                Enregistrement audio de la conversation
              </p>
              <p className="text-xs text-zinc-400">
                Disponible à la réécoute (voix du participant et d&apos;Anaïs)
              </p>
            </div>
          </div>
          <audio
            controls
            src={audioSrc}
            onError={handleAudioError}
            className="h-10 w-full sm:w-80"
            aria-label="Lecteur audio de l'entretien"
          />
        </div>
      )}

      {/* Blocking Points List */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold text-white">
          01. Points bloquants identifiés
        </h2>
        <div className="mt-4 space-y-4">
          {record.summary.keyPainPoints.map((point, idx) => (
            <article
              key={`${point.title}-${idx}`}
              className="rounded-2xl border border-white/10 bg-[#0B0B0D] p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-white">
                  {point.title}
                </h3>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-zinc-400">{point.category}</span>
                  <span aria-hidden="true" className="text-zinc-600">
                    ·
                  </span>
                  <span
                    className={`font-semibold ${
                      point.severity === 'Critique'
                        ? 'text-red-400'
                        : point.severity === 'Élevé'
                          ? 'text-amber-300'
                          : 'text-emerald-400'
                    }`}
                  >
                    Gravité : {point.severity}
                  </span>
                </div>
              </div>

              <p className="mt-2.5 text-sm leading-relaxed text-zinc-300">
                {point.impact}
              </p>

              {point.quote && (
                <p className="mt-2.5 text-xs italic text-zinc-400">
                  « {point.quote} »
                </p>
              )}

              <p className="mt-3 border-t border-white/5 pt-3 text-xs text-emerald-300/90">
                Action recommandée : {point.recommendedAction}
              </p>
            </article>
          ))}
        </div>
      </div>

      {/* Agency X Recommended Offers */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold text-white">
          02. Pistes d&apos;accompagnement L&apos;Agence X
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {record.summary.recommendedOffers.map((item, idx) => (
            <div
              key={`${item.offer}-${idx}`}
              className="rounded-2xl border border-white/10 bg-[#0B0B0D] p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-white">
                  {item.offer}
                </h3>
                <span
                  className={`text-xs font-medium ${
                    item.relevance === 'Prioritaire'
                      ? 'text-[#D4A853]'
                      : 'text-zinc-400'
                  }`}
                >
                  {item.relevance}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                {item.rationale}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Structured Answers & Decision Factors */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold text-white">
            03. Réponses structurées du questionnaire
          </h2>
          {record.summary.structuredAnswers.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">
              Aucune réponse structurée consignée sur cet échange.
            </p>
          ) : (
            <div className="mt-4 divide-y divide-white/10 rounded-2xl border border-white/10 bg-[#0B0B0D]">
              {record.summary.structuredAnswers.map((ans, idx) => (
                <div
                  key={`${ans.questionId}-${idx}`}
                  className="grid gap-1 px-5 py-3.5 sm:grid-cols-3 sm:gap-4"
                >
                  <div className="text-xs font-medium text-zinc-400">
                    <span className="font-mono text-[#D4A853]">
                      {ans.questionId}
                    </span>{' '}
                    · {ans.label}
                  </div>
                  <div className="text-sm text-zinc-100 sm:col-span-2">
                    {ans.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="text-lg font-semibold text-white">
            04. Leviers & suite
          </h2>
          <div className="mt-4 rounded-2xl border border-white/10 bg-[#0B0B0D] p-5">
            {record.summary.decisionFactors.length > 0 && (
              <>
                <p className="text-xs font-medium text-zinc-400">
                  Facteurs de décision
                </p>
                <ul className="mt-2 space-y-2 text-xs leading-relaxed text-zinc-200">
                  {record.summary.decisionFactors.map((factor, idx) => (
                    <li key={idx}>• {factor}</li>
                  ))}
                </ul>
              </>
            )}

            <div className="mt-5 border-t border-white/10 pt-4">
              <p className="text-xs font-medium text-zinc-400">
                Prochaine étape suggérée
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-zinc-200">
                {record.summary.nextSteps}
              </p>
            </div>

            {record.contactInfo && (
              <div className="mt-4 border-t border-white/10 pt-4">
                <p className="text-xs font-medium text-zinc-400">
                  Coordonnées laissées
                </p>
                <p className="mt-1 text-xs text-white">{record.contactInfo}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Transcript Section */}
      <div className="mt-10 border-t border-white/10 pt-8">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <MessageSquare className="h-4 w-4 text-zinc-400" />
            <span>05. Transcription complète ({record.transcript.length} échanges)</span>
          </h2>
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            aria-expanded={showTranscript}
            className="text-xs text-zinc-400 hover:text-white"
          >
            {showTranscript ? 'Réduire' : 'Afficher'}
          </button>
        </div>

        {showTranscript && (
          <div className="mt-4 space-y-3 rounded-2xl border border-white/10 bg-[#0B0B0D] p-5">
            {record.transcript.length === 0 ? (
              <p className="text-xs text-zinc-500">
                Aucune transcription textuelle enregistrée pour cet entretien.
              </p>
            ) : (
              record.transcript.map((entry) => (
                <div
                  key={entry.id}
                  className="flex gap-3 text-sm leading-relaxed"
                >
                  <span className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-zinc-500">
                    {entry.timestamp}
                  </span>
                  <div>
                    <span
                      className={`font-semibold ${
                        entry.speaker === 'anais'
                          ? 'text-[#D4A853]'
                          : 'text-white'
                      }`}
                    >
                      {entry.speaker === 'anais'
                        ? 'Anaïs'
                        : record.participantName}
                      {' : '}
                    </span>
                    <span className="text-zinc-300">{entry.text}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <p className="mt-8 flex items-center gap-2 text-xs text-zinc-500">
        <FileText className="h-3.5 w-3.5" />
        <span>
          Synthèse rédigée automatiquement par Anaïs · Accessible hors ligne et
          exportable en PDF.
        </span>
      </p>
    </section>
  );
};
