import {
  resolveBackendApiUrl,
  resolveLiveWebSocketUrl,
} from './interviewLogic';

const BACKEND_BASE_URL = (
  import.meta.env.VITE_BACKEND_URL as string | undefined
)?.trim();

export function getApiUrl(path: string): string {
  return resolveBackendApiUrl(path, BACKEND_BASE_URL);
}

export function getLiveWsUrl(): string {
  return resolveLiveWebSocketUrl(window.location, BACKEND_BASE_URL);
}

export function hasCustomBackendUrl(): boolean {
  return Boolean(BACKEND_BASE_URL);
}
