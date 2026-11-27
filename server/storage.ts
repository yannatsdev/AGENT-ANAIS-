import fs from 'fs';
import path from 'path';
import type { InterviewRecord } from '../src/types/interview.ts';
import {
  isLegacySeedId,
  isValidInterviewId,
  stripAudioDataUriPrefix,
} from '../src/utils/interviewLogic.ts';

const DATA_ROOT = path.resolve(process.cwd(), 'data', 'interviews');
const AUDIO_ROOT = path.resolve(DATA_ROOT, 'audio');
const SEED_MARKER = path.resolve(DATA_ROOT, '.seeded');

function ensureDirs(): void {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.mkdirSync(AUDIO_ROOT, { recursive: true });
}

function resolveSafeRecordPath(id: string): string {
  if (!isValidInterviewId(id)) {
    throw new Error('Identifiant entretien invalide.');
  }
  const resolved = path.resolve(DATA_ROOT, `${id}.json`);
  if (!resolved.startsWith(DATA_ROOT + path.sep)) {
    throw new Error('Chemin non autorisé.');
  }
  return resolved;
}

function resolveSafeAudioPath(id: string): string {
  if (!isValidInterviewId(id)) {
    throw new Error('Identifiant audio invalide.');
  }
  const resolved = path.resolve(AUDIO_ROOT, `${id}.webm`);
  if (!resolved.startsWith(AUDIO_ROOT + path.sep)) {
    throw new Error('Chemin audio non autorisé.');
  }
  return resolved;
}

export function purgeLegacySeedFiles(): void {
  ensureDirs();
  for (const legacyId of ['seed-mkt-abidjan-01', 'seed-dg-abidjan-02']) {
    try {
      const legacyPath = resolveSafeRecordPath(legacyId);
      if (fs.existsSync(legacyPath)) {
        fs.unlinkSync(legacyPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
  try {
    if (fs.existsSync(SEED_MARKER)) {
      fs.unlinkSync(SEED_MARKER);
    }
  } catch {
    // Ignore
  }
}

export function listInterviews(): InterviewRecord[] {
  ensureDirs();
  const files = fs.readdirSync(DATA_ROOT).filter((f) => f.endsWith('.json'));
  const records: InterviewRecord[] = [];

  for (const file of files) {
    const baseId = file.replace(/\.json$/i, '');
    if (isLegacySeedId(baseId)) continue;
    try {
      const raw = fs.readFileSync(path.join(DATA_ROOT, file), 'utf-8');
      const parsed = JSON.parse(raw) as InterviewRecord;
      if (parsed?.id && !isLegacySeedId(parsed.id)) {
        records.push(parsed);
      }
    } catch {
      // Skip unreadable JSON
    }
  }

  return records.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getInterviewById(id: string): InterviewRecord | null {
  ensureDirs();
  if (isLegacySeedId(id)) return null;
  try {
    const filePath = resolveSafeRecordPath(id);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as InterviewRecord;
  } catch {
    return null;
  }
}

export function saveInterviewRecord(
  record: InterviewRecord,
  audioBase64?: string
): InterviewRecord {
  ensureDirs();
  let hasAudioRecording = record.hasAudioRecording;
  let audioUrl = record.audioUrl;

  if (audioBase64 && typeof audioBase64 === 'string' && audioBase64.length > 0) {
    // Strip optional data URI prefix including codec params (e.g. data:audio/webm;codecs=opus;base64,)
    const cleanBase64 = stripAudioDataUriPrefix(audioBase64);
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.length > 0 && buffer.length <= 25 * 1024 * 1024) {
      const audioPath = resolveSafeAudioPath(record.id);
      const tmpAudioPath = `${audioPath}.tmp`;
      fs.writeFileSync(tmpAudioPath, buffer);
      fs.renameSync(tmpAudioPath, audioPath);
      hasAudioRecording = true;
      audioUrl = `/api/interviews/${record.id}/audio`;
    }
  }

  const finalRecord: InterviewRecord = {
    ...record,
    hasAudioRecording,
    audioUrl,
    syncStatus: 'synced',
  };

  const targetPath = resolveSafeRecordPath(finalRecord.id);
  const tmpTargetPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpTargetPath, JSON.stringify(finalRecord, null, 2), 'utf-8');
  fs.renameSync(tmpTargetPath, targetPath);
  return finalRecord;
}

export function getAudioFilePath(id: string): string | null {
  try {
    const audioPath = resolveSafeAudioPath(id);
    return fs.existsSync(audioPath) ? audioPath : null;
  } catch {
    return null;
  }
}

export function deleteInterviewRecord(id: string): boolean {
  try {
    const jsonPath = resolveSafeRecordPath(id);
    const audioPath = resolveSafeAudioPath(id);
    let deleted = false;
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
      deleted = true;
    }
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
    return deleted;
  } catch {
    return false;
  }
}
