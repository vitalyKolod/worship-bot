import path from "node:path";
import { mkdir, stat, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../../config/env";
import { StemName } from "../../models/Song";

const EXTENSIONS = new Map([["audio/mpeg", ".mp3"], ["audio/mp3", ".mp3"], ["audio/wav", ".wav"], ["audio/x-wav", ".wav"], ["audio/mp4", ".m4a"], ["audio/x-m4a", ".m4a"]]);
const ALLOWED_EXTENSIONS = new Set([".mp3", ".wav", ".m4a"]);

export function normalizeAudioExtension(fileName?: string, mimeType?: string): string | null {
  const fromMime = mimeType ? EXTENSIONS.get(mimeType.toLowerCase()) : undefined;
  const fromName = fileName ? path.extname(path.basename(fileName)).toLowerCase() : "";
  return fromMime ?? (ALLOWED_EXTENSIONS.has(fromName) ? fromName : null);
}

export function safeSongDirectory(songId: string): string {
  if (!/^[a-f\d]{24}$/i.test(songId)) throw new Error("Invalid song id for audio storage");
  return path.resolve(env.audio.storagePath, songId);
}

export function audioPaths(songId: string) {
  const root = safeSongDirectory(songId);
  return { root, original: path.join(root, "original"), stems: path.join(root, "stems"), mixes: path.join(root, "mixes") };
}

export function stemPath(songId: string, stem: StemName): string {
  return path.join(audioPaths(songId).stems, `${stem}.wav`);
}

export async function ensureAudioDirectories(songId: string): Promise<ReturnType<typeof audioPaths>> {
  const paths = audioPaths(songId);
  await Promise.all([mkdir(paths.original, { recursive: true }), mkdir(paths.stems, { recursive: true }), mkdir(paths.mixes, { recursive: true })]);
  return paths;
}

export async function resetDerivedAudio(songId: string): Promise<void> {
  const paths = audioPaths(songId);
  await Promise.all([rm(paths.stems, { recursive: true, force: true }), rm(paths.mixes, { recursive: true, force: true })]);
  await Promise.all([mkdir(paths.stems, { recursive: true }), mkdir(paths.mixes, { recursive: true })]);
}

export async function saveResponseBody(response: Response, destination: string, maxBytes: number, onProgress?: (received: number) => void): Promise<number> {
  if (!response.ok || !response.body) throw new Error(`Audio download failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (declared && declared > maxBytes) throw new Error("Audio file exceeds configured size limit");
  let received = 0;
  const source = Readable.fromWeb(response.body as never);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received);
    if (received > maxBytes) source.destroy(new Error("Audio file exceeds configured size limit"));
  });
  await pipeline(source, createWriteStream(destination, { flags: "wx" }));
  return received;
}

export async function existingFile(filePath: string): Promise<boolean> {
  try { return (await stat(filePath)).isFile() && (await stat(filePath)).size > 0; } catch { return false; }
}
