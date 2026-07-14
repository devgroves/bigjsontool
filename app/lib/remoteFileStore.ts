import type { IndexData } from "./buildIndex";

export interface RemoteFileEntry {
  url: string;
  index: IndexData | null;
  depth1Snapshot: any | null;
  totalBytes: number | null;
  complete: boolean;
}

const store = new Map<string, RemoteFileEntry>();

export function getRemoteEntry(id: string): RemoteFileEntry | undefined {
  return store.get(id);
}

export function setRemoteEntry(id: string, entry: RemoteFileEntry): void {
  store.set(id, entry);
}

export function deleteRemoteEntry(id: string): void {
  store.delete(id);
}
