import { Types } from "mongoose";
import { AudioJob } from "../../models/AudioJob";
import { Song } from "../../models/Song";

export type AudioJobStatus = "pending" | "processing" | "completed" | "failed";
const TRANSITIONS: Record<AudioJobStatus, readonly AudioJobStatus[]> = {
  pending: ["processing"], processing: ["completed", "failed", "pending"], completed: [], failed: ["pending"],
};
export function canTransitionAudioJob(from: AudioJobStatus, to: AudioJobStatus): boolean { return TRANSITIONS[from].includes(to); }

export async function createSeparationJob(songId: Types.ObjectId | string, userId: Types.ObjectId | string, inputPath: string, outputDir: string, progressMessage?: { chatId: number; messageId: number }) {
  const existing = await AudioJob.findOne({ songId, type: "separation", status: { $in: ["pending", "processing"] } });
  if (existing) return existing;
  const job = await AudioJob.create({ songId, userId, inputPath, outputDir, status: "pending", stage: "queued", progressChatId: progressMessage?.chatId, progressMessageId: progressMessage?.messageId });
  await Song.updateOne({ _id: songId }, { $set: { "audio.processingStatus": "queued" } });
  console.info("audio_job_created", { jobId: job.id, songId: String(songId), userId: String(userId) });
  return job;
}

export async function claimNextJob() {
  return AudioJob.findOneAndUpdate(
    { status: "pending" },
    { $set: { status: "processing", stage: "separating", startedAt: new Date(), heartbeatAt: new Date(), analysisPercent: 0, savedStems: [] }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: "after" }
  );
}

export async function requeueStaleJobs(cutoff: Date): Promise<void> {
  const stale = { status: "processing" as const, $or: [
    { heartbeatAt: { $lt: cutoff } },
    { heartbeatAt: { $exists: false }, startedAt: { $lt: cutoff } },
  ] };
  const exhausted = await AudioJob.find({ ...stale, attempts: { $gte: 3 } }).select("_id songId").lean();
  if (exhausted.length) {
    const ids = exhausted.map((job) => job._id);
    await AudioJob.updateMany({ _id: { $in: ids }, status: "processing" }, { $set: { status: "failed", stage: "failed", error: "Обработка прервалась три раза. Повтори задачу вручную.", finishedAt: new Date() }, $unset: { heartbeatAt: 1 } });
    await Song.updateMany({ _id: { $in: exhausted.map((job) => job.songId) } }, { $set: { "audio.processingStatus": "failed" } });
    console.warn("audio_stale_jobs_failed", { count: exhausted.length });
  }
  const requeued = await AudioJob.updateMany({ ...stale, attempts: { $lt: 3 } }, { $set: { status: "pending", stage: "queued", analysisPercent: 0, savedStems: [], error: "Worker stopped before completing the task" }, $unset: { startedAt: 1, heartbeatAt: 1 } });
  if (requeued.modifiedCount) console.warn("audio_stale_jobs_requeued", { count: requeued.modifiedCount });
}

export async function retryJob(jobId: string): Promise<boolean> {
  const job = await AudioJob.findOneAndUpdate({ _id: jobId, status: "failed" }, { $set: { status: "pending", stage: "queued", attempts: 0, analysisPercent: 0, savedStems: [] }, $unset: { error: 1, finishedAt: 1, heartbeatAt: 1, startedAt: 1 } }, { returnDocument: "after" });
  if (job) await Song.updateOne({ _id: job.songId }, { $set: { "audio.processingStatus": "queued" } });
  return Boolean(job);
}
