import React from 'react';
import { MARQUEE_PHRASES } from '../data/questionnaires';

export const MarqueeBanner: React.FC = () => {
  const repeated = [...MARQUEE_PHRASES, ...MARQUEE_PHRASES];

  return (
    <div
      className="relative w-full overflow-hidden border-y border-white/10 bg-[#08080A] py-2.5 select-none"
      aria-label="Manifeste L'Agence X"
    >
      <div className="animate-agence-marquee flex items-center whitespace-nowrap">
        {[0, 1].map((loopIndex) => (
          <div
            key={loopIndex}
            className="flex shrink-0 items-center"
            aria-hidden={loopIndex === 1}
          >
            {repeated.map((phrase, idx) => (
              <React.Fragment key={`${loopIndex}-${idx}`}>
                <span
                  className="px-6 text-[11px] font-medium tracking-[0.18em] text-zinc-400"
                  style={{ fontFamily: 'var(--font-sans)' }}
                >
                  {phrase}
                </span>
                <span
                  className="text-zinc-600 text-xs font-light"
                  aria-hidden="true"
                >
                  ×
                </span>
              </React.Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
