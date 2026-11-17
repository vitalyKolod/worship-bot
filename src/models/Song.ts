import { Schema, model, Types, InferSchemaType } from "mongoose";

export const MOODS = ["worship", "upbeat", "other"] as const;
export type Mood = (typeof MOODS)[number];
export const STEM_NAMES = ["vocals", "drums", "bass", "guitar", "piano", "other"] as const;
export type StemName = (typeof STEM_NAMES)[number];

const audioFileSchema = new Schema({
  path: { type: String, required: true },
  mimeType: String,
  fileName: String,
  size: Number,
}, { _id: false });

const stemSchema = new Schema({
  path: { type: String, required: true },
  size: Number,
}, { _id: false });

const sectionSchema = new Schema({
  name: { type: String, required: true },
  at: { type: Number, required: true },
  variant: Number,
}, { _id: false });

const chartSectionSchema = new Schema({
  name: { type: String, required: true },
  label: { type: String, required: true },
  weight: { type: Number, required: true },
  lyrics: { type: [String], default: undefined },
  variant: Number,
  draftAt: Number,
}, { _id: false });

const songSchema = new Schema({
  team: { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
  title: { type: String, required: true },
  artist: String,
  genre: String,
  mood: { type: String, enum: MOODS, default: "other" }, // веселая / для поклонения / другое
  key: String, // тональность, напр. "G", "C#m"
  chords: String, // аккорды или ссылка на них
  timeSignature: String, // музыкальный размер, напр. "4/4" или "6/8"
  tempo: Number, // BPM
  notes: String, // "капо на 2 ладу" и т.п.
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
  archivedAt: Date,
  audio: {
    original: audioFileSchema,
    processingStatus: {
      type: String,
      enum: ["none", "awaiting_chords", "queued", "processing", "completed", "failed"],
      default: "none",
    },
    stems: {
      vocals: stemSchema,
      drums: stemSchema,
      bass: stemSchema,
      guitar: stemSchema,
      piano: stemSchema,
      other: stemSchema,
    },
    accompaniment: {
      tempo: Number,
      beatsPerBar: Number,
      firstBeatAt: Number,
      beats: { type: [Number], default: undefined },
      source: { type: String, enum: ["automatic", "manual"] },
      sections: { type: [sectionSchema], default: undefined },
      click: stemSchema,
      guide: stemSchema,
      status: { type: String, enum: ["needs_review", "ready", "failed"], default: "needs_review" },
      error: String,
    },
    guideChart: {
      url: String,
      sections: { type: [chartSectionSchema], default: undefined },
      status: { type: String, enum: ["imported", "draft", "confirmed"] },
      importedAt: Date,
    },
    analysis: {
      separator: String,
      model: String,
      processedAt: Date,
    },
  },
});

// текстовый поиск по названию и исполнителю
songSchema.index({ title: "text", artist: "text" });
songSchema.index({ team: 1, title: 1 });
songSchema.index({ team: 1, archivedAt: 1, title: 1 });

export type SongDoc = InferSchemaType<typeof songSchema>;
export const Song = model("Song", songSchema);
