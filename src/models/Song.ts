import { Schema, model, Types, InferSchemaType } from "mongoose";

export const MOODS = ["worship", "upbeat", "other"] as const;
export type Mood = (typeof MOODS)[number];

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
});

// текстовый поиск по названию и исполнителю
songSchema.index({ title: "text", artist: "text" });
songSchema.index({ team: 1, title: 1 });

export type SongDoc = InferSchemaType<typeof songSchema>;
export const Song = model("Song", songSchema);
