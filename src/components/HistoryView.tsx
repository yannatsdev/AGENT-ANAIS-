import React, { useMemo, useState } from 'react';
import {
  Download,
  Headphones,
  Plus,
  Search,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { InterviewProfile, InterviewRecord } from '../types/interview';
import { filterInterviews, formatDuration } from '../utils/interviewLogic';
import { exportInterviewToPdf } from '../utils/pdfExport';

interface HistoryViewProps {
  interviews: InterviewRecord[];
  isOnline: boolean;
  onSelectInterview: (record: InterviewRecord) => void;
  onDeleteInterview: (id: string) => void;
  onStartNew: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  interviews,
  isOnline,
  onSelectInterview,
  onDeleteInterview,
  onStartNew,
}) => {
  const [profileFilter, setProfileFilter] = useState<'all' | InterviewProfile>(
    'all'
  );
  const [query, setQuery] = useState('');
  const [exportedId, setExportedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const filtered = useMemo(
    () => filterInterviews(interviews, profileFilter, query),
    [interviews, profileFilter, query]
  );

  const handleQuickPdf = (e: React.MouseEvent, record: InterviewRecord) => {
    e.stopPropagation();
    exportInterviewToPdf(record);
    setExportedId(record.id);
    window.setTimeout(() => setExportedId(null), 2500);
  };

  return (
    <section
      className="mx-auto w-full max-w-6xl px-6 py-10"
      aria-label="Historique complet des entretiens"
    >
      {/* Header row */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <p className="text-xs tracking-[0.2em] text-zinc-500 uppercase">
            Archives & Synthèses
          </p>
          <h1 className="mt-1.5 text-3xl font-bold tracking-tight text-white">
            Historique complet des entretiens
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              {isOnline ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-amber-400" />
              )}
              <span>
                {isOnline
                  ? 'Synchronisé · Copie locale disponible hors ligne'
                  : 'Mode hors ligne actif · Consultation locale complète'}
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {interviews.length} entretien{interviews.length > 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onStartNew}
          className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>Nouvel entretien avec Anaïs</span>
        </button>
      </div>

      {/* Filters & Search toolbar */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="inline-flex items-center gap-1 rounded-xl border border-white/10 bg-[#0B0B0D] p-1"
          role="group"
          aria-label="Filtrer par profil"
        >
          {(
            [
              { id: 'all', label: 'Tous' },
              { id: 'marketing', label: 'Directeur·rice Marketing' },
              { id: 'dg', label: 'Directeur·rice Général·e' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setProfileFilter(tab.id)}
              aria-pressed={profileFilter === tab.id}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                profileFilter === tab.id
                  ? 'bg-white text-black'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-80">
          <label htmlFor="history-search" className="sr-only">
            Rechercher un entretien par entreprise, participant ou point bloquant
          </label>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            id="history-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher entreprise, participant, blocage…"
            className="w-full rounded-xl border border-white/15 bg-[#0B0B0D] py-2 pr-3.5 pl-10 text-xs text-white placeholder:text-zinc-500 focus:border-white/40 focus:outline-none"
          />
        </div>
      </div>

      {/* Interview list */}
      {interviews.length === 0 ? (
        <div
          className="mt-10 rounded-2xl border border-white/10 bg-[#0B0B0D] px-6 py-16 text-center"
          data-testid="history-empty-state"
        >
          <p className="text-base font-semibold text-white">
            Aucun entretien enregistré pour le moment
          </p>
          <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-zinc-400">
            Vos conversations avec Anaïs s&apos;enregistrent automatiquement ici
            dès que vous confirmez la fin d&apos;un entretien, avec leur
            synthèse, transcription, audio et export PDF.
          </p>
          <button
            type="button"
            onClick={onStartNew}
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>Démarrer mon premier entretien</span>
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-white/10 bg-[#0B0B0D] px-6 py-14 text-center">
          <p className="text-sm font-medium text-white">
            Aucun entretien ne correspond à votre recherche.
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Modifiez vos filtres ou réinitialisez la recherche.
          </p>
          <button
            type="button"
            onClick={() => {
              setProfileFilter('all');
              setQuery('');
            }}
            className="mt-4 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-white/10"
          >
            Réinitialiser les filtres
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3" data-testid="history-list">
          {filtered.map((item) => {
            const createdDate = new Date(item.createdAt);
            const formattedDate = createdDate.toLocaleDateString('fr-FR', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            });
            const formattedTime = createdDate.toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const roleLabel =
              item.profile === 'marketing'
                ? 'Directeur·rice Marketing'
                : 'Directeur·rice Général·e';

            return (
              <article
                key={item.id}
                className="group flex flex-col justify-between gap-4 rounded-2xl border border-white/10 bg-[#0B0B0D] p-5 transition-colors hover:border-white/25 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
                    <span className="font-medium text-zinc-200">
                      {roleLabel}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {formattedDate} à {formattedTime}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {formatDuration(item.durationSeconds)}
                    </span>
                    {item.hasAudioRecording && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1 text-[#D4A853]">
                          <Headphones className="h-3 w-3" />
                          Audio
                        </span>
                      </>
                    )}
                    {item.syncStatus !== 'synced' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-400">Local hors ligne</span>
                      </>
                    )}
                  </div>

                  <h2 className="mt-1.5 text-base font-semibold text-white">
                    {item.companyName} — {item.participantName}
                  </h2>

                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                    {item.summary.headline} · {item.summary.keyPainPoints.length}{' '}
                    point{item.summary.keyPainPoints.length > 1 ? 's' : ''} bloquant
                    {item.summary.keyPainPoints.length > 1 ? 's' : ''} identifié
                    {item.summary.keyPainPoints.length > 1 ? 's' : ''}.
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectInterview(item)}
                    className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-white hover:text-black whitespace-nowrap"
                  >
                    Voir la synthèse
                  </button>

                  <button
                    type="button"
                    onClick={(e) => handleQuickPdf(e, item)}
                    aria-label={`Exporter ${item.companyName} en PDF`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-white/40 hover:text-white whitespace-nowrap"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>{exportedId === item.id ? 'Exporté' : 'PDF'}</span>
                  </button>

                  {confirmDeleteId === item.id ? (
                    <div
                      className="flex items-center gap-1.5"
                      role="group"
                      aria-label={`Confirmer la suppression de ${item.companyName}`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteId(null);
                          onDeleteInterview(item.id);
                        }}
                        className="rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-500 whitespace-nowrap"
                      >
                        Supprimer
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/35 hover:text-white whitespace-nowrap"
                      >
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(item.id)}
                      aria-label={`Supprimer l'entretien de ${item.companyName}`}
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-zinc-500 transition-colors hover:border-red-500/40 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
