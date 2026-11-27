import { InterviewRecord } from '../types/interview';
import { isLegacySeedId } from './interviewLogic';

const DB_NAME = 'agence_x_anais_offline_v1';
const DB_VERSION = 1;
const STORE_INTERVIEWS = 'interviews';
const STORE_AUDIO = 'audio_blobs';

const PENDING_DELETES_KEY = 'agence_x_pending_deletes_v1';

let cachedDbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (cachedDbPromise) {
    return cachedDbPromise;
  }
  cachedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      cachedDbPromise = null;
      reject(new Error('IndexedDB indisponible'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_INTERVIEWS)) {
        db.createObjectStore(STORE_INTERVIEWS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        cachedDbPromise = null;
      };
      db.onclose = () => {
        cachedDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      cachedDbPromise = null;
      reject(request.error);
    };
  });
  return cachedDbPromise;
}

export function getPendingDeleteIds(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_DELETES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

export function addPendingDeleteId(id: string): void {
  try {
    const set = new Set(getPendingDeleteIds());
    set.add(id);
    localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Ignore restricted storage
  }
}

export function removePendingDeleteId(id: string): void {
  try {
    const next = getPendingDeleteIds().filter((item) => item !== id);
    if (next.length === 0) {
      localStorage.removeItem(PENDING_DELETES_KEY);
    } else {
      localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(next));
    }
  } catch {
    // Ignore restricted storage
  }
}

export async function saveInterviewOffline(
  record: InterviewRecord,
  audioBlob?: Blob | null
): Promise<void> {
  if (isLegacySeedId(record.id)) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_INTERVIEWS, STORE_AUDIO], 'readwrite');
      tx.objectStore(STORE_INTERVIEWS).put(record);
      if (audioBlob) {
        tx.objectStore(STORE_AUDIO).put({ id: record.id, blob: audioBlob });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Sauvegarde IndexedDB ignorée:', err);
  }
}

export async function getAllOfflineInterviews(): Promise<InterviewRecord[]> {
  try {
    const db = await openDb();
    const records = await new Promise<InterviewRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_INTERVIEWS, 'readonly');
      const req = tx.objectStore(STORE_INTERVIEWS).getAll();
      req.onsuccess = () => resolve((req.result as InterviewRecord[]) || []);
      req.onerror = () => reject(req.error);
    });

    // Automatically purge any legacy fake demo records left in browser IndexedDB
    const legacyIds = records
      .filter((r) => isLegacySeedId(r.id))
      .map((r) => r.id);
    if (legacyIds.length > 0) {
      for (const id of legacyIds) {
        await deleteInterviewOffline(id);
      }
    }

    return records
      .filter((r) => !isLegacySeedId(r.id))
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  } catch {
    return [];
  }
}

export async function getOfflineAudioBlob(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<{ id: string; blob: Blob } | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_AUDIO, 'readonly');
        const req = tx.objectStore(STORE_AUDIO).get(id);
        req.onsuccess = () =>
          resolve(req.result as { id: string; blob: Blob } | undefined);
        req.onerror = () => reject(req.error);
      }
    );
    return entry?.blob ?? null;
  } catch {
    return null;
  }
}

export async function getOfflineAudioUrl(id: string): Promise<string | null> {
  const blob = await getOfflineAudioBlob(id);
  return blob ? URL.createObjectURL(blob) : null;
}

export async function deleteInterviewOffline(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_INTERVIEWS, STORE_AUDIO], 'readwrite');
      tx.objectStore(STORE_INTERVIEWS).delete(id);
      tx.objectStore(STORE_AUDIO).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Suppression IndexedDB ignorée:', err);
  }
}

export async function mergeServerAndOfflineInterviews(
  serverRecords: InterviewRecord[]
): Promise<InterviewRecord[]> {
  const localRecords = await getAllOfflineInterviews();
  const pendingDeletes = new Set(getPendingDeleteIds());
  const byId = new Map<string, InterviewRecord>();

  for (const local of localRecords) {
    if (!isLegacySeedId(local.id) && !pendingDeletes.has(local.id)) {
      byId.set(local.id, local);
    }
  }
  for (const remote of serverRecords) {
    if (isLegacySeedId(remote.id) || pendingDeletes.has(remote.id)) continue;
    const existingLocal = byId.get(remote.id);
    const mergedRecord: InterviewRecord = {
      ...remote,
      hasAudioRecording:
        remote.hasAudioRecording || Boolean(existingLocal?.hasAudioRecording),
      syncStatus: 'synced',
    };
    byId.set(remote.id, mergedRecord);
    await saveInterviewOffline(mergedRecord);
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
