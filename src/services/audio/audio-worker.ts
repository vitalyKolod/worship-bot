import mongoose from "mongoose";
import { Api, InlineKeyboard } from "grammy";
import { env } from "../../config/env";
import { AudioJob } from "../../models/AudioJob";
import { Song } from "../../models/Song";
import { User } from "../../models/User";
import { STEM_NAMES, StemName } from "../../models/Song";
import { claimNextJob, requeueStaleJobs } from "./audio-job.service";
import { separateAudio } from "./audio-separation.service";
import { prepareAutomaticClick } from "./automatic-click.service";
import { createAccompaniment } from "./audio-accompaniment.service";
import { analyzeSongWithRouterAi } from "./routerai-audio.service";

let stopping = false;
let running = false;
const telegram = new Api(env.botToken);
const STEM_LABELS: Record<StemName, string> = { vocals: "Вокал", drums: "Барабаны", bass: "Бас", guitar: "Гитара", piano: "Клавиши", other: "Остальное" };
function progressBar(value: number): string {
  const filled = Math.max(0, Math.min(10, Math.floor(value / 10)));
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
}
async function notifyUser(userId: typeof AudioJob.prototype.userId, songId: string, text: string): Promise<void> {
  try {
    const user = await User.findById(userId).select("telegramId");
    if (user?.telegramId) await telegram.sendMessage(user.telegramId, text, { reply_markup: new InlineKeyboard().text("🎚 ОТКРЫТЬ ПЕСНЮ", `ap:status:${songId}`) });
  } catch (error) {
    console.warn("audio_notification_failed", { songId, error: error instanceof Error ? error.message : String(error) });
  }
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function updateQueueScreens(): Promise<void> {
  const jobs = await AudioJob.find({ status: "pending" }).sort({ createdAt: 1 });
  if (!jobs.length) return;
  const active = await AudioJob.countDocuments({ status: "processing" });
  for (const [index, job] of jobs.entries()) {
    if (!(await AudioJob.exists({ _id: job._id, status: "pending" }))) continue;
    const song = await Song.findById(job.songId).select("title");
    const title = (song?.title ?? "Песня").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const elapsed = Math.max(0, Math.floor((Date.now() - job.createdAt.getTime()) / 60_000));
    const text = `🎧 <b>${title}</b>\n\n✅ Файл загружен\n⏳ В очереди: №${index + active + 1}\n${active ? "🎛 Сейчас обрабатывается другая песня\n" : ""}⏱ Ожидание: ${elapsed} мин\n\n${progressBar(10)}\nШаг 1/3: очередь`;
    try {
      if (!job.progressMessageId) {
        const user = await User.findById(job.userId).select("telegramId");
        if (!user?.telegramId) continue;
        const sent = await telegram.sendMessage(user.telegramId, text, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ К ПЕСНЕ", `song:o:${job.songId}`) });
        await AudioJob.updateOne({ _id: job._id, status: "pending", progressMessageId: { $exists: false } }, { $set: { progressChatId: user.telegramId, progressMessageId: sent.message_id } });
      } else {
        await telegram.editMessageText(job.progressChatId!, job.progressMessageId, text, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ К ПЕСНЕ", `song:o:${job.songId}`) });
      }
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("message is not modified"))) console.warn("audio_queue_update_failed", { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
    }
    await wait(1100);
  }
}

async function attachActiveScreen(): Promise<void> {
  const jobs = await AudioJob.find({ status: "processing", progressMessageId: { $exists: false } });
  for (const job of jobs) {
    const [user, song] = await Promise.all([User.findById(job.userId).select("telegramId"), Song.findById(job.songId).select("title")]);
    if (!user?.telegramId) continue;
    const title = (song?.title ?? "Песня").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const sent = await telegram.sendMessage(user.telegramId, `🎧 <b>${title}</b>\n\n🎛 Анализирую аудио\n⏱ Обработка идёт в фоне\n\n${progressBar(Math.floor((job.analysisPercent ?? 0) * 0.8))}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ К ПЕСНЕ", `song:o:${job.songId}`) });
    await AudioJob.updateOne({ _id: job._id, status: "processing", progressMessageId: { $exists: false } }, { $set: { progressChatId: user.telegramId, progressMessageId: sent.message_id } });
  }
}

async function updateActiveHeartbeat(): Promise<void> {
  const jobs = await AudioJob.find({ status: "processing", progressMessageId: { $exists: true }, analysisPercent: { $in: [0, null] } });
  for (const job of jobs) {
    if (!job.progressChatId || !job.progressMessageId) continue;
    const song = await Song.findById(job.songId).select("title");
    const title = (song?.title ?? "Песня").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const elapsed = Math.max(0, Math.floor((Date.now() - (job.startedAt?.getTime() ?? Date.now())) / 60_000));
    try {
      await telegram.editMessageText(job.progressChatId, job.progressMessageId, `🎧 <b>${title}</b>\n\n✅ Файл загружен\n🎛 Анализирую аудио\n⏱ В работе: ${elapsed} мин\n\n${progressBar(10)}\nШаг 2/3: разделение`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ К ПЕСНЕ", `song:o:${job.songId}`) });
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("message is not modified"))) console.warn("audio_active_update_failed", { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
    }
    await wait(1100);
  }
}

async function processOne(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;
  const started = Date.now();
  const heartbeat = setInterval(() => {
    void AudioJob.updateOne({ _id: job._id, status: "processing" }, { $set: { heartbeatAt: new Date() } }).catch((error) => console.warn("audio_heartbeat_failed", error));
  }, 10_000);
  console.info("audio_job_started", { jobId: job.id, songId: String(job.songId), userId: String(job.userId) });
  let analysisPercent = 0;
  const savedStems: StemName[] = [];
  let lastText = "";
  let progressQueue = Promise.resolve();
  const publish = (text: string, state: "working" | "completed" | "failed" = "working") => {
    if (text === lastText) return;
    lastText = text;
    progressQueue = progressQueue.then(async () => {
      try {
        const target = job.progressMessageId ? job : await AudioJob.findById(job._id).select("progressChatId progressMessageId");
        if (!target?.progressChatId || !target.progressMessageId) return;
        await telegram.editMessageText(target.progressChatId, target.progressMessageId, text, {
          parse_mode: "HTML",
          reply_markup: state === "completed"
            ? new InlineKeyboard().text("🎚 ОТКРЫТЬ ДОРОЖКИ", `ap:o:${job.songId}`)
            : state === "failed"
              ? new InlineKeyboard().text("🔄 ПОВТОРИТЬ", `ap:retry:${job.songId}`).row().text("⬅️ К ПЕСНЕ", `song:o:${job.songId}`)
              : new InlineKeyboard().text("⬅️ К ПЕСНЕ", `song:o:${job.songId}`),
        });
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("message is not modified"))) console.warn("audio_progress_update_failed", { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
      }
      await wait(1100);
    });
  };
  const title = async () => (await Song.findById(job.songId).select("title"))?.title ?? "Песня";
  try {
    await Song.updateOne({ _id: job.songId }, { $set: { "audio.processingStatus": "processing" } });
    const songTitle = await title();
    const heading = `🎧 <b>${songTitle.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</b>\n\n`;
    publish(`${heading}✅ Файл загружен\n🎛 Анализирую аудио...\n\n${progressBar(0)}`);
    const stems = await separateAudio(String(job.songId), job.inputPath, job.outputDir, undefined, (progress) => {
      if (progress.stage === "separating") {
        if (progress.percent <= analysisPercent) return;
        analysisPercent = progress.percent;
        const value = Math.floor(analysisPercent * 0.8);
        publish(`${heading}✅ Файл загружен\n🎛 Анализирую аудио: ${analysisPercent}%\n\n${progressBar(value)}`);
        void AudioJob.updateOne({ _id: job._id }, { $set: { analysisPercent } }).catch((error) => console.warn("audio_progress_save_failed", error));
      } else {
        savedStems.push(progress.stem);
        const value = 80 + Math.floor(savedStems.length / STEM_NAMES.length * 15);
        publish(`${heading}✅ Анализ завершён\n${savedStems.map((stem) => `✅ Сохранено: ${STEM_LABELS[stem]}`).join("\n")}\n\n${progressBar(value)}`);
        void AudioJob.updateOne({ _id: job._id }, { $addToSet: { savedStems: progress.stem } }).catch((error) => console.warn("audio_progress_save_failed", error));
      }
    });
    await progressQueue;
    await AudioJob.updateOne({ _id: job._id }, { $set: { stage: "saving" } });
    publish(`${heading}✅ Инструменты разделены\n🥁 Определяю темп и доли для клика...\n\n${progressBar(95)}`);
    await AudioJob.updateOne({ _id: job._id }, { $set: { stage: "beat_analysis" } });
    let clickStatus = "⏱ Клик: нужна ручная настройка в playback";
    let accompaniment: Record<string, unknown> = { status: "needs_review" };
    try {
      const song = await Song.findById(job.songId).select("tempo timeSignature");
      if (!stems.drums?.path) throw new Error("Дорожка барабанов недоступна для анализа ритма.");
      let prepared = await prepareAutomaticClick(String(job.songId), job.inputPath, stems.drums.path, song?.tempo ?? undefined, song?.timeSignature ?? undefined);
      if (prepared.status === "ready") {
        if (env.audio.routerAiKey) {
          try {
            const proposal = await analyzeSongWithRouterAi(job.inputPath, prepared.beats, prepared.beatsPerBar);
            if (proposal.downbeatIndex !== undefined) {
              const firstBeatAt = prepared.beats[proposal.downbeatIndex];
              const files = await createAccompaniment(String(job.songId), job.inputPath, { tempo: prepared.tempo, beatsPerBar: prepared.beatsPerBar, firstBeatAt, beats: prepared.beats, sections: [] });
              prepared = { ...prepared, firstBeatAt, ...files };
            }
            await Song.updateOne({ _id: job.songId, "audio.guideChart.sections": { $exists: false } }, { $set: { "audio.guideChart.sections": proposal.sections, "audio.guideChart.status": "draft" } });
          } catch (error) {
            console.warn("audio_ai_suggestion_failed", { songId: String(job.songId), error: error instanceof Error ? error.message : String(error) });
          }
        }
        accompaniment = prepared;
        clickStatus = `✅ Клик готов: ~${prepared.tempo} BPM. Проверь синхронизацию на слух.`;
        console.info("audio_click_ready", { songId: String(job.songId), bpm: prepared.tempo, beats: prepared.beats.length });
      } else {
        accompaniment = prepared;
        console.warn("audio_click_needs_review", { songId: String(job.songId), reason: prepared.error });
      }
    } catch (error) {
      accompaniment = { status: "needs_review", error: error instanceof Error ? error.message.slice(0, 300) : "Ошибка анализа клика." };
      console.warn("audio_click_analysis_failed", { songId: String(job.songId), error: error instanceof Error ? error.message : String(error) });
    }
    await Song.updateOne({ _id: job.songId }, { $set: { "audio.processingStatus": "completed", "audio.stems": stems, "audio.accompaniment": accompaniment, "audio.analysis": { separator: "demucs", model: env.audio.separatorModel, processedAt: new Date() } } });
    await AudioJob.updateOne({ _id: job._id }, { $set: { status: "completed", stage: "completed", finishedAt: new Date() }, $unset: { error: 1 } });
    console.info("audio_job_completed", { jobId: job.id, songId: String(job.songId), duration: Date.now() - started });
    publish(`${heading}✅ Песня разделена на дорожки\n${savedStems.map((stem) => `✅ ${STEM_LABELS[stem]}`).join("\n")}\n${clickStatus}\n🎙 Проверь разметку частей перед созданием гайда\n\n${progressBar(100)}`, "completed");
    await progressQueue;
    if (!(await AudioJob.exists({ _id: job._id, progressMessageId: { $exists: true } }))) await notifyUser(job.userId, String(job.songId), "✅ Песня разделена на дорожки. Можно включать и убирать инструменты.");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 8000) : String(error).slice(0, 8000);
    await Promise.all([
      AudioJob.updateOne({ _id: job._id }, { $set: { status: "failed", stage: "failed", error: message, finishedAt: new Date() } }),
      Song.updateOne({ _id: job.songId }, { $set: { "audio.processingStatus": "failed" } }),
    ]);
    console.error("audio_job_failed", { jobId: job.id, songId: String(job.songId), duration: Date.now() - started, error: message });
    await progressQueue;
    publish(`🎧 <b>Разделение песни</b>\n\n⚠️ Не удалось разделить аудио. Можно повторить обработку или загрузить другой файл.\n\n${progressBar(Math.floor(analysisPercent * 0.8))}`, "failed");
    await progressQueue;
    if (!(await AudioJob.exists({ _id: job._id, progressMessageId: { $exists: true } }))) await notifyUser(job.userId, String(job.songId), "⚠️ Не удалось разделить песню. Открой статус, чтобы повторить обработку.");
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export function startAudioWorker(): void {
  if (!env.audio.enabled || running) return;
  stopping = false;
  running = true;
  let monitorRunning = false;
  const monitor = async () => {
    if (monitorRunning) return;
    monitorRunning = true;
    try { await attachActiveScreen(); await updateActiveHeartbeat(); await updateQueueScreens(); }
    catch (error) { console.warn("audio_queue_monitor_failed", error); }
    finally { monitorRunning = false; }
  };
  const queueTimer = setInterval(() => { void monitor(); }, 15_000);
  void (async () => {
    await requeueStaleJobs(new Date(Date.now() - 120_000));
    await monitor();
    console.info("audio_worker_started", { maxConcurrentJobs: 1 });
    while (!stopping) {
      try {
        await requeueStaleJobs(new Date(Date.now() - 120_000));
        if (!(await processOne())) await wait(env.audio.workerPollMs);
      } catch (error) {
        console.error("audio_worker_loop_failed", error);
        await wait(env.audio.workerPollMs);
      }
    }
  })().catch((error) => console.error("audio_worker_fatal", error)).finally(() => { clearInterval(queueTimer); running = false; });
}

async function main() {
  if (!env.audio.enabled) throw new Error("AUDIO_PROCESSING_ENABLED is not enabled");
  if (env.audio.maxConcurrentJobs !== 1) console.warn("This worker intentionally processes one separation job at a time", { configured: env.audio.maxConcurrentJobs });
  await mongoose.connect(env.mongodbUri);
  await AudioJob.syncIndexes();
  startAudioWorker();
  while (!stopping) await wait(env.audio.workerPollMs);
  await mongoose.disconnect();
}

if (require.main === module) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; });
  main().catch((error) => { console.error("audio_worker_fatal", { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
}
