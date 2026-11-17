import path from "node:path";
import { rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { Api } from "grammy";
import { env } from "../../config/env";
import { Song } from "../../models/Song";
import { User } from "../../models/User";

import { ensureAudioDirectories, normalizeAudioExtension, resetDerivedAudio, saveResponseBody } from "./audio-storage.service";

async function downloadWithCurl(url: string, destination: string, maxBytes: number, onProgress?: (received: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "2", "--max-time", "180", "--max-filesize", String(maxBytes), "--output", destination, "--config", "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setInterval(() => { void stat(destination).then((file) => onProgress?.(file.size)).catch(() => {}); }, 1500);
    child.stdin.end(`url = "${url}"\n`);
    child.once("error", (error) => { clearInterval(timer); reject(error); });
    child.once("close", (code) => {
      clearInterval(timer);
      if (code !== 0) return reject(new Error(`Telegram file download failed (curl ${code}): ${stderr.slice(-300)}`));
      void stat(destination).then((file) => file.size <= maxBytes ? resolve(file.size) : reject(new Error("Audio file exceeds configured size limit")), reject);
    });
  });
}

export async function receiveTelegramAudio(api: Api, songId: string, telegramUserId: number, file: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }, onProgress?: (received: number) => void ) {
  if (!env.audio.enabled) throw new Error("Audio processing is disabled");
  if (file.file_size && file.file_size > env.audio.maxUploadBytes) throw new Error("Audio file exceeds configured size limit");
  const extension = normalizeAudioExtension(file.file_name, file.mime_type);
  if (!extension) throw new Error("Unsupported audio format");
  const [song, user] = await Promise.all([Song.findById(songId), User.findOne({ telegramId: telegramUserId })]);
  if (!song || !user) throw new Error("Song or user not found");
  if (song.audio?.processingStatus === "queued" || song.audio?.processingStatus === "processing") throw new Error("Audio is already processing");
  const directories = await ensureAudioDirectories(songId);
  const destination = path.join(directories.original, `source${extension}`);
  const temporary = path.join(directories.original, `.upload-${Date.now()}${extension}`);
  const telegramFile = await api.getFile(file.file_id);
  if (!telegramFile.file_path) throw new Error("Telegram did not return a file path");
  const url = `https://api.telegram.org/file/bot${env.botToken}/${telegramFile.file_path}`;
  console.info("audio_upload_received", { songId, userId: user.id, size: file.file_size });
  try {
    let size: number;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      size = await saveResponseBody(response, temporary, env.audio.maxUploadBytes, onProgress);
    } catch (error) {
      if (error instanceof Error && /size limit|HTTP 4\d\d/.test(error.message)) throw error;
      console.warn("audio_fetch_retry_with_curl", { songId, cause: error instanceof Error ? error.message : String(error) });
      await rm(temporary, { force: true });
      size = await downloadWithCurl(url, temporary, env.audio.maxUploadBytes, onProgress);
    }
    await rename(temporary, destination);
    await resetDerivedAudio(songId);
    await Song.updateOne({ _id: songId }, { $set: { "audio.original": { path: destination, mimeType: file.mime_type, fileName: path.basename(file.file_name || `audio${extension}`), size }, "audio.processingStatus": "awaiting_chords" }, $unset: { "audio.stems": 1, "audio.analysis": 1, "audio.accompaniment": 1, "audio.guideChart": 1 } });
    return { songId: song._id, userId: user._id, inputPath: destination, outputDir: directories.stems };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
