import { InferSchemaType, Schema, model } from "mongoose";

const audioJobSchema = new Schema({
  songId: { type: Schema.Types.ObjectId, ref: "Song", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["separation"], default: "separation" },
  status: { type: String, enum: ["pending", "processing", "completed", "failed"], default: "pending", index: true },
  stage: { type: String, enum: ["uploaded", "queued", "separating", "saving", "beat_analysis", "completed", "failed"], default: "queued" },
  inputPath: { type: String, required: true },
  outputDir: { type: String, required: true },
  progressChatId: Number,
  progressMessageId: Number,
  analysisPercent: { type: Number, default: 0 },
  savedStems: { type: [String], default: [] },
  attempts: { type: Number, default: 0 },
  error: String,
  startedAt: Date,
  heartbeatAt: Date,
  finishedAt: Date,
}, { timestamps: true });

audioJobSchema.index({ status: 1, createdAt: 1 });

export type AudioJobDoc = InferSchemaType<typeof audioJobSchema>;
export const AudioJob = model("AudioJob", audioJobSchema);
