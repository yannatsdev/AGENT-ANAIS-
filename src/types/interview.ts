export type InterviewProfile = 'marketing' | 'dg';

export type VoiceEngine = 'gemini-3.8-live';

export type PainPointSeverity = 'Critique' | 'Élevé' | 'Modéré';

export interface TranscriptEntry {
  id: string;
  speaker: 'anais' | 'participant';
  text: string;
  timestamp: string;
  themeCode?: string;
}

export interface CapturedNote {
  questionId: string;
  section: string;
  topic: string;
  answer: string;
  painLevel?: 'low' | 'medium' | 'high';
  capturedAt: string;
}

export interface PainPointItem {
  title: string;
  category: string;
  severity: PainPointSeverity;
  impact: string;
  quote?: string;
  recommendedAction: string;
}

export interface AgencyOfferRecommendation {
  offer: 'Formation & FDFP' | 'Audit & Procédures' | 'Agents & Automatisations' | 'Outil Clé en Main';
  relevance: 'Prioritaire' | 'Complémentaire';
  rationale: string;
}

export interface StructuredAnswer {
  questionId: string;
  section: string;
  label: string;
  value: string;
}

export interface InterviewSummary {
  headline: string;
  executiveSummary: string;
  timeLostEstimate: string;
  maturityLevel: string;
  keyPainPoints: PainPointItem[];
  recommendedOffers: AgencyOfferRecommendation[];
  structuredAnswers: StructuredAnswer[];
  decisionFactors: string[];
  nextSteps: string;
  generatedBy: string;
}

export interface InterviewRecord {
  id: string;
  profile: InterviewProfile;
  voiceEngine: VoiceEngine;
  participantName: string;
  companyName: string;
  contactInfo?: string;
  createdAt: string;
  durationSeconds: number;
  transcript: TranscriptEntry[];
  capturedNotes: CapturedNote[];
  summary: InterviewSummary;
  hasAudioRecording: boolean;
  audioUrl?: string;
  syncStatus: 'synced' | 'offline-only' | 'pending-sync';
}

export interface ProviderStatus {
  geminiLiveAvailable: boolean;
  aiGatewayEnabled: boolean;
  aiGatewayLabel: string;
  defaultEngine: VoiceEngine;
}

export interface QuestionnaireSection {
  code: string;
  title: string;
  questionIds: string[];
  focusSummary: string;
}
