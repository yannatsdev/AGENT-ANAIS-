import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  Type,
} from '@google/genai';
import type {
  FunctionDeclaration,
  LiveServerMessage,
} from '@google/genai';
import type {
  CapturedNote,
  InterviewProfile,
  InterviewSummary,
  ProviderStatus,
  TranscriptEntry,
  VoiceEngine,
} from '../src/types/interview.ts';
import {
  buildAnaisSystemInstruction,
  buildStrategicSummaryChecklist,
} from '../src/data/questionnaires.ts';
import {
  cleanLiveTranscriptFragment,
  sanitizePromptField,
} from '../src/utils/interviewLogic.ts';

function isBlockedGatewayHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '::1' ||
    lower === '[::1]' ||
    lower.endsWith('.local') ||
    lower.startsWith('127.') ||
    lower.startsWith('10.') ||
    lower.startsWith('169.254.') ||
    lower.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(lower)
  ) {
    return true;
  }
  return false;
}

function normalizeGatewayBaseUrl(): string | undefined {
  const raw = process.env.AI_GATEWAY_URL?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }
    if (isBlockedGatewayHost(parsed.hostname)) {
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function getProviderStatus(): ProviderStatus {
  const gatewayUrl = normalizeGatewayBaseUrl();
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();

  const geminiLiveAvailable = Boolean(geminiKey || (gatewayUrl && gatewayKey));
  const aiGatewayEnabled = Boolean(gatewayUrl);

  let aiGatewayLabel = 'Passerelle serveur directe';
  if (gatewayUrl) {
    try {
      const host = new URL(gatewayUrl).host;
      aiGatewayLabel = `AI Gateway (${host})`;
    } catch {
      aiGatewayLabel = 'AI Gateway actif';
    }
  }

  return {
    geminiLiveAvailable,
    aiGatewayEnabled,
    aiGatewayLabel,
    defaultEngine: 'gemini-3.8-live',
  };
}

export function createGeminiClient(): GoogleGenAI {
  const gatewayUrl = normalizeGatewayBaseUrl();
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.AI_GATEWAY_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      'Clé GEMINI_API_KEY ou AI_GATEWAY_API_KEY non configurée dans les Secrets du serveur.'
    );
  }

  const headers: Record<string, string> = {
    'User-Agent': 'aistudio-build',
  };
  if (gatewayUrl && process.env.AI_GATEWAY_API_KEY?.trim()) {
    headers['Authorization'] = `Bearer ${process.env.AI_GATEWAY_API_KEY.trim()}`;
  }

  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      ...(gatewayUrl ? { baseUrl: `${gatewayUrl}/google-ai-studio` } : {}),
      headers,
    },
  });
}

const recordAnswerTool: FunctionDeclaration = {
  name: 'enregistrer_reponse',
  description:
    "Enregistre discrètement une réponse clé ou un point bloquant mentionné par le participant pendant l'entretien, sans interrompre la fluidité de la conversation.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      questionId: {
        type: Type.STRING,
        description: 'Identifiant exact de la question du questionnaire à jour (Q1 à Q26).',
      },
      section: {
        type: Type.STRING,
        description: 'Lettre du bloc thématique (A, B, C, D, E ou F).',
      },
      topic: {
        type: Type.STRING,
        description: 'Court intitulé du sujet abordé (ex: Validations WhatsApp, Budget mensuel).',
      },
      answer: {
        type: Type.STRING,
        description: 'Résumé fidèle et concis de ce que le participant a dit.',
      },
      painLevel: {
        type: Type.STRING,
        description: "Niveau d'irritation ou de blocage perçu : low, medium ou high.",
      },
    },
    required: ['questionId', 'section', 'topic', 'answer'],
  },
};

const finishInterviewTool: FunctionDeclaration = {
  name: 'terminer_entretien',
  description:
    "Signale à l'application que l'entretien est terminé après les remerciements chaleureux d'Anaïs afin de lancer la synthèse automatique.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      contactInfo: {
        type: Type.STRING,
        description: 'Coordonnées facultatives laissées par le participant (email ou WhatsApp).',
      },
      wantsStudyResults: {
        type: Type.BOOLEAN,
        description: "True si le participant souhaite recevoir les résultats de l'étude.",
      },
      wantsFollowUpCall: {
        type: Type.BOOLEAN,
        description: "True si le participant souhaite échanger 20 minutes avec L'Agence X.",
      },
    },
  },
};

export interface LiveBridgeCallbacks {
  onAudioChunk: (base64Pcm24k: string) => void;
  onInterrupted: () => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onNoteCaptured: (note: CapturedNote) => void;
  onInterviewCompleteSignal: (meta: {
    contactInfo?: string;
    wantsStudyResults?: boolean;
    wantsFollowUpCall?: boolean;
  }) => void;
  onReady: (engineLabel: string) => void;
  onTurnComplete?: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export interface ActiveLiveBridge {
  sendAudioPcm16k: (base64Pcm16k: string) => void;
  sendTextTurn: (text: string) => void;
  close: () => void;
}

/**
 * Opens a real-time Gemini 3.8 Live voice session bridged over WebSocket.
 */
export async function openGeminiLiveBridge(
  profile: InterviewProfile,
  participantName: string,
  companyName: string,
  callbacks: LiveBridgeCallbacks,
  resumeContext?: string
): Promise<ActiveLiveBridge> {
  const ai = createGeminiClient();
  const safeParticipantName = sanitizePromptField(participantName, 100);
  const safeCompanyName = sanitizePromptField(companyName, 120);
  const baseInstruction = buildAnaisSystemInstruction(
    profile,
    safeParticipantName,
    safeCompanyName
  );
  const systemInstruction = resumeContext?.trim()
    ? `${baseInstruction}\n\nREPRISE APRÈS MICRO-COUPURE RÉSEAU :\nL'entretien est déjà en cours. Ne refais PAS l'introduction complète et ne repose PAS les questions déjà traitées ci-dessous. Reprends chaleureusement et brièvement le fil là où vous en étiez.\n${resumeContext.trim()}`
    : baseInstruction;

  let closed = false;

  const session = await ai.live.connect({
    model: 'gemini-3.8-live',
    config: {
      responseModalities: [Modality.AUDIO],
      temperature: 0.4,
      speechConfig: {
        languageCode: 'fr-FR',
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Zephyr' },
        },
      },
      inputAudioTranscription: {
        languageCodes: ['fr-FR'],
      },
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
          prefixPaddingMs: 80,
          silenceDurationMs: 650,
        },
      },
      tools: [{ functionDeclarations: [recordAnswerTool, finishInterviewTool] }],
      systemInstruction,
    },
    callbacks: {
      onopen: () => {
        callbacks.onReady('AX Live');
      },
      onmessage: (message: LiveServerMessage) => {
        if (closed) return;
        const content = message.serverContent;

        if (content?.interrupted) {
          callbacks.onInterrupted();
        }

        if (content?.inputTranscription?.text) {
          const cleanedInput = cleanLiveTranscriptFragment(
            content.inputTranscription.text
          );
          if (cleanedInput) {
            callbacks.onInputTranscript(cleanedInput);
          }
        }
        if (content?.outputTranscription?.text) {
          const cleanedOutput = cleanLiveTranscriptFragment(
            content.outputTranscription.text
          );
          if (cleanedOutput) {
            callbacks.onOutputTranscript(cleanedOutput);
          }
        }

        for (const part of content?.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) {
            callbacks.onAudioChunk(part.inlineData.data);
          }
        }

        if (content?.turnComplete) {
          callbacks.onTurnComplete?.();
        }

        const calls = message.toolCall?.functionCalls ?? [];
        if (calls.length > 0) {
          const functionResponses = calls.map((call) => {
            const args = (call.args ?? {}) as Record<string, unknown>;
            if (call.name === 'enregistrer_reponse') {
              const painRaw = String(args.painLevel || 'medium');
              const painLevel: 'low' | 'medium' | 'high' =
                painRaw === 'high' || painRaw === 'low' ? painRaw : 'medium';
              callbacks.onNoteCaptured({
                questionId: String(args.questionId || 'Q?'),
                section: String(args.section || 'A').toUpperCase().slice(0, 1),
                topic: String(args.topic || 'Observation'),
                answer: String(args.answer || ''),
                painLevel,
                capturedAt: new Date().toISOString(),
              });
              return {
                id: call.id,
                name: call.name,
                response: { ok: true, saved: true },
              };
            }

            if (call.name === 'terminer_entretien') {
              callbacks.onInterviewCompleteSignal({
                contactInfo: args.contactInfo ? String(args.contactInfo) : undefined,
                wantsStudyResults: Boolean(args.wantsStudyResults),
                wantsFollowUpCall: Boolean(args.wantsFollowUpCall),
              });
              return {
                id: call.id,
                name: call.name,
                response: { ok: true, closing: true },
              };
            }

            return {
              id: call.id,
              name: call.name,
              response: { ok: true },
            };
          });

          try {
            session.sendToolResponse({ functionResponses });
          } catch (err) {
            console.error('Erreur sendToolResponse Gemini Live:', err);
          }
        }
      },
      onerror: (e: unknown) => {
        const msg =
          e instanceof Error
            ? e.message
            : 'Erreur de connexion au service vocal en direct.';
        callbacks.onError(msg);
      },
      onclose: () => {
        if (!closed) {
          closed = true;
          callbacks.onClose();
        }
      },
    },
  });

  // Trigger Anaïs's opening greeting or seamless reconnection continuation
  try {
    const openingPrompt = resumeContext?.trim()
      ? "La connexion vocale vient d'être rétablie. Dis simplement en une phrase courte, posée et chaleureuse que tu es de retour, puis poursuis la conversation là où vous en étiez."
      : "L'entretien vient de démarrer. Salue chaleureusement le participant en disant « Salut », prononce distinctement « Anaïs » en trois syllabes (A-na-ïsse) et « L'Agence X » en français (L'Agence Ixe), parle d'un ton naturel et posé en marquant de petites pauses entre tes phrases, et pose uniquement ta toute première question.";
    session.sendClientContent({
      turns: [
        {
          role: 'user',
          parts: [
            {
              text: openingPrompt,
            },
          ],
        },
      ],
      turnComplete: true,
    });
  } catch (err) {
    console.warn('Greeting trigger warning:', err);
  }

  return {
    sendAudioPcm16k: (base64Pcm16k: string) => {
      if (closed) return;
      try {
        session.sendRealtimeInput({
          audio: {
            data: base64Pcm16k,
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      } catch {
        // Ignore transient write after close
      }
    },
    sendTextTurn: (text: string) => {
      if (closed || !text.trim()) return;
      try {
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: text.trim() }] }],
          turnComplete: true,
        });
      } catch (err) {
        callbacks.onError(
          err instanceof Error ? err.message : "Impossible d'envoyer le message."
        );
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        session.close();
      } catch {
        // Already closed
      }
    },
  };
}

export async function openLiveBridge(
  _engine: VoiceEngine,
  profile: InterviewProfile,
  participantName: string,
  companyName: string,
  callbacks: LiveBridgeCallbacks,
  resumeContext?: string
): Promise<ActiveLiveBridge> {
  return openGeminiLiveBridge(
    profile,
    participantName,
    companyName,
    callbacks,
    resumeContext
  );
}

/**
 * Generates an executive structured pain-point summary from the interview transcript
 * and captured notes using Gemini 4 Hydrogen (via AI Gateway when configured).
 */
export async function generateInterviewSummary(params: {
  profile: InterviewProfile;
  participantName: string;
  companyName: string;
  transcript: TranscriptEntry[];
  capturedNotes: CapturedNote[];
}): Promise<InterviewSummary> {
  const ai = createGeminiClient();
  const roleLabel =
    params.profile === 'marketing'
      ? 'Directeur·rice Marketing (Questionnaire PME ivoiriennes à jour - 26 questions, blocs A à E)'
      : 'Directeur·rice Général·e (Questionnaire PME ivoiriennes à jour - 26 questions, blocs A à F)';

  const safeParticipantName = sanitizePromptField(params.participantName, 100);
  const safeCompanyName = sanitizePromptField(params.companyName, 120);

  const transcriptText = params.transcript
    .map(
      (t) =>
        `[${t.timestamp}] ${t.speaker === 'anais' ? 'Anaïs' : safeParticipantName || 'Participant'}: ${t.text}`
    )
    .join('\n');

  const notesText = params.capturedNotes
    .map((n) => `- [${n.section} / ${n.questionId}] ${n.topic}: ${n.answer}`)
    .join('\n');

  const strategicChecklist = buildStrategicSummaryChecklist(params.profile);

  const prompt = `Tu es un consultant senior de L'Agence X (Abidjan, Côte d'Ivoire).
Analyse l'entretien vocal ci-dessous mené par Anaïs auprès d'un(e) ${roleLabel}.

Participant : ${safeParticipantName || 'Anonyme'}
Entreprise : ${safeCompanyName || 'Non précisée'}

${strategicChecklist}

NOTES CAPTÉES EN DIRECT :
${notesText || 'Aucune note structurée captée.'}

TRANSCRIPTION COMPLÈTE :
${transcriptText || 'Entretien court sans transcription détaillée.'}

Produis une synthèse claire, stratégique, concrète et exploitable en français :
- Identifie les points bloquants réels (sévérité Critique, Élevé ou Modéré), leur impact temps/coût/risque et une recommandation précise.
- Mets en lumière les signaux stratégiques clés issus du formulaire à jour : maturité & usages IA, dispersion des licences / visibilité (Shadow IA), sécurité/incidents, avantages attendus d'une solution d'IA dédiée entreprise, déclencheurs à 6 mois, compétences internes, budgets (FCFA), décideurs et éligibilité FDFP.
- Relie les constats aux 4 offres de L'Agence X : "Formation & FDFP", "Audit & Procédures", "Agents & Automatisations", "Outil Clé en Main".
- Restitue dans structuredAnswers les réponses structurées alignées sur les identifiants Q1 à Q26 réellement couverts durant l'échange, sans inventer de données non mentionnées.
- Ne mentionne jamais le nom "Portia".`;

  let parsed: Partial<Omit<InterviewSummary, 'generatedBy'>> = {};
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              headline: { type: Type.STRING },
              executiveSummary: { type: Type.STRING },
              timeLostEstimate: { type: Type.STRING },
              maturityLevel: { type: Type.STRING },
              keyPainPoints: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    category: { type: Type.STRING },
                    severity: {
                      type: Type.STRING,
                      enum: ['Critique', 'Élevé', 'Modéré'],
                    },
                    impact: { type: Type.STRING },
                    quote: { type: Type.STRING },
                    recommendedAction: { type: Type.STRING },
                  },
                  required: ['title', 'category', 'severity', 'impact', 'recommendedAction'],
                },
              },
              recommendedOffers: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    offer: {
                      type: Type.STRING,
                      enum: [
                        'Formation & FDFP',
                        'Audit & Procédures',
                        'Agents & Automatisations',
                        'Outil Clé en Main',
                      ],
                    },
                    relevance: {
                      type: Type.STRING,
                      enum: ['Prioritaire', 'Complémentaire'],
                    },
                    rationale: { type: Type.STRING },
                  },
                  required: ['offer', 'relevance', 'rationale'],
                },
              },
              structuredAnswers: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    questionId: { type: Type.STRING },
                    section: { type: Type.STRING },
                    label: { type: Type.STRING },
                    value: { type: Type.STRING },
                  },
                  required: ['questionId', 'section', 'label', 'value'],
                },
              },
              decisionFactors: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              nextSteps: { type: Type.STRING },
            },
            required: [
              'headline',
              'executiveSummary',
              'timeLostEstimate',
              'maturityLevel',
              'keyPainPoints',
              'recommendedOffers',
              'structuredAnswers',
              'decisionFactors',
              'nextSteps',
            ],
          },
        },
      });
      const rawText = (response.text ?? '{}')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      parsed = JSON.parse(rawText || '{}') as Partial<Omit<InterviewSummary, 'generatedBy'>>;
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable =
        err instanceof SyntaxError ||
        msg.includes('503') ||
        msg.includes('429') ||
        msg.includes('UNAVAILABLE');
      if (attempt === 0 && isRetryable) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      throw err;
    }
  }
  if (lastError) {
    throw lastError;
  }

  const validOffers = new Set([
    'Formation & FDFP',
    'Audit & Procédures',
    'Agents & Automatisations',
    'Outil Clé en Main',
  ]);

  return {
    headline: parsed.headline || 'Synthèse des points bloquants identifiés',
    executiveSummary: parsed.executiveSummary || 'Synthèse générée à partir de votre échange avec Anaïs.',
    timeLostEstimate: parsed.timeLostEstimate || 'À préciser',
    maturityLevel: parsed.maturityLevel || 'En cours de structuration',
    keyPainPoints: (parsed.keyPainPoints || []).map((p) => {
      const sev = String(p.severity || '').trim().toLowerCase();
      const severity: 'Critique' | 'Élevé' | 'Modéré' =
        sev.startsWith('crit')
          ? 'Critique'
          : sev.startsWith('mod')
            ? 'Modéré'
            : 'Élevé';
      return {
        title: p.title,
        category: p.category,
        severity,
        impact: p.impact,
        quote: p.quote,
        recommendedAction: p.recommendedAction,
      };
    }),
    recommendedOffers: (parsed.recommendedOffers || []).map((o) => {
      const cleanOffer = String(o.offer || '').trim();
      const rel = String(o.relevance || '').trim().toLowerCase();
      return {
        offer: (validOffers.has(cleanOffer)
          ? cleanOffer
          : 'Audit & Procédures') as InterviewSummary['recommendedOffers'][number]['offer'],
        relevance: rel.startsWith('prio') ? 'Prioritaire' : 'Complémentaire',
        rationale: o.rationale,
      };
    }),
    structuredAnswers: parsed.structuredAnswers || [],
    decisionFactors: parsed.decisionFactors || [],
    nextSteps: parsed.nextSteps || "Planifier un échange de 20 minutes avec L'Agence X.",
    generatedBy: normalizeGatewayBaseUrl() ? 'gemini-4-hydrogen (AI Gateway)' : 'gemini-4-hydrogen',
  };
}
