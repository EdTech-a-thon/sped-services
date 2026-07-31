import type { GridSettings } from "./types";

/**
 * The workbook never leaves the browser. We keep the uploaded bytes in
 * localStorage purely so a teacher who closes the tab does not have to find the
 * file again, and everything can be wiped from the UI.
 */
const FILE_KEY = "sped-scheduler:workbook";
const SETTINGS_KEY = "sped-scheduler:settings";

/** Base64 inflates by ~4/3, so stay well clear of the usual 5 MB quota. */
const MAX_STORED_BYTES = 2_000_000;

export interface StoredWorkbook {
  fileName: string;
  savedAt: string;
  bytes: ArrayBuffer;
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  // Chunked to avoid blowing the argument limit on large files.
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const view = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return view.buffer;
}

export function saveWorkbook(fileName: string, bytes: ArrayBuffer): void {
  if (bytes.byteLength > MAX_STORED_BYTES) {
    localStorage.removeItem(FILE_KEY);
    return;
  }
  try {
    localStorage.setItem(
      FILE_KEY,
      JSON.stringify({
        fileName,
        savedAt: new Date().toISOString(),
        data: toBase64(bytes),
      }),
    );
  } catch {
    // Quota or private-browsing failure: the app works fine without the cache.
    localStorage.removeItem(FILE_KEY);
  }
}

export function loadWorkbook(): StoredWorkbook | null {
  try {
    const raw = localStorage.getItem(FILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      fileName?: string;
      savedAt?: string;
      data?: string;
    };
    if (!parsed.data) return null;
    return {
      fileName: parsed.fileName ?? "workbook.xlsx",
      savedAt: parsed.savedAt ?? "",
      bytes: fromBase64(parsed.data),
    };
  } catch {
    return null;
  }
}

export function saveSettings(settings: GridSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* not worth surfacing */
  }
}

export function loadSettings(): GridSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GridSettings>;
    if (
      typeof parsed.startMinutes !== "number" ||
      typeof parsed.endMinutes !== "number" ||
      typeof parsed.slotMinutes !== "number"
    ) {
      return null;
    }
    return parsed as GridSettings;
  } catch {
    return null;
  }
}

export function clearStorage(): void {
  localStorage.removeItem(FILE_KEY);
  localStorage.removeItem(SETTINGS_KEY);
}
