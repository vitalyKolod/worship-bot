import { InferSchemaType, Schema, model } from "mongoose";

export const SERVICE_STATUSES = ["scheduled", "cancelled", "completed"] as const;

const lineupSchema = new Schema({
  role: { type: String, required: true, trim: true, maxlength: 80 },
  slotLabel: { type: String, trim: true, maxlength: 80 },
  displayName: { type: String, trim: true, maxlength: 100 },
  userTelegramId: Number,
}, { _id: false });

const setlistItemSchema = new Schema({
  song: { type: Schema.Types.ObjectId, ref: "Song", required: true },
  order: { type: Number, required: true, min: 1 },
  section: { type: String, enum: ["main", "transition", "offering"], default: "main" },
  key: { type: String, trim: true, maxlength: 20 },
  bpm: { type: Number, min: 1, max: 500 },
  comment: { type: String, trim: true, maxlength: 300 },
}, { _id: false });

const historySchema = new Schema({
  from: { type: Date, required: true },
  to: { type: Date, required: true },
  changedBy: { type: Number, required: true },
  changedAt: { type: Date, default: Date.now },
}, { _id: false });

const worshipServiceSchema = new Schema({
  team: { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
  startsAt: { type: Date, required: true, index: true },
  soundcheckAt: Date,
  location: { type: String, trim: true, maxlength: 200 },
  title: { type: String, trim: true, maxlength: 120, default: "Служение" },
  status: { type: String, enum: SERVICE_STATUSES, default: "scheduled", index: true },
  lineup: { type: [lineupSchema], default: [] },
  setlist: { type: [setlistItemSchema], default: [] },
  history: { type: [historySchema], default: [] },
  createdBy: { type: Number, required: true },
  cancelledBy: Number,
  cancelledAt: Date,
  completionPromptSent: { type: Boolean, default: false },
  announcementChatId: Number,
  announcementMessageId: Number,
}, { timestamps: true });

worshipServiceSchema.index({ team: 1, startsAt: 1 });
worshipServiceSchema.index({ team: 1, status: 1, startsAt: 1 });

export type WorshipServiceDoc = InferSchemaType<typeof worshipServiceSchema>;
export const WorshipService = model("WorshipService", worshipServiceSchema);
