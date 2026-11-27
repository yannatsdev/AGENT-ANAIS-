import React, { useState } from 'react';
import { Download, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWA';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-white hover:text-black whitespace-nowrap shrink-0"
      >
        <Download className="h-3.5 w-3.5" />
        <span>Installer l&apos;app</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/10 whitespace-nowrap shrink-0"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Mode hors ligne iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#101014] p-6 shadow-2xl">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-white">
                  Installer Anaïs sur iPhone / iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Fermer le guide iOS"
                  className="text-zinc-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-zinc-300">
                1. Touchez le bouton <strong>Partager</strong> dans la barre Safari.
                <br />
                2. Sélectionnez <strong>Sur l&apos;écran d&apos;accueil</strong> pour
                accéder à tout votre historique même hors ligne.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-full bg-white py-2 text-xs font-semibold text-black hover:bg-zinc-200"
              >
                Compris
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-amber-400/35 bg-[#1A1508]/95 px-4 py-2 text-xs font-medium text-amber-200 shadow-lg backdrop-blur-md"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-400" />
      <span>Mode hors ligne — Historique local &amp; export PDF disponibles</span>
    </div>
  );
};
