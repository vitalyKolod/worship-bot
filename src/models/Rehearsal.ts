import { InferSchemaType, Schema, model } from "mongoose";

export const REHEARSAL_STATUSES = ["scheduled", "cancelled", "completed"] as const;

const historySchema = new Schema({
  from: { type: Date, required: true },
  to: { type: Date, required: true },
  changedBy: { type: Number, required: true },
  changedAt: { type: Date, default: Date.now },
}, { _id: false });

const lineupSchema = new Schema({
  role: { type: String, required: true, trim: true, maxlength: 80 },
  slotLabel: { type: String, trim: true, maxlength: 80 },
  displayName: { type: String, trim: true, maxlength: 100 },
  userTelegramId: Number,
}, { _id: false });

const rehearsalSchema = new Schema({
  team: { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
  service: { type: Schema.Types.ObjectId, ref: "WorshipService" },
  startsAt: { type: Date, required: true, index: true },
  location: { type: String, trim: true, maxlength: 200 },
  comment: { type: String, trim: true, maxlength: 500 },
  lineup: { type: [lineupSchema], default: [] },
  status: { type: String, enum: REHEARSAL_STATUSES, default: "scheduled", index: true },
  createdBy: { type: Number, required: true },
  cancelledBy: Number,
  cancelledAt: Date,
  history: { type: [historySchema], default: [] },
  reminder24hSent: { type: Boolean, default: false },
  reminder2hSent: { type: Boolean, default: false },
  sourceAction: { type: Schema.Types.ObjectId, ref: "PendingAction" },
}, { timestamps: true });

rehearsalSchema.index({ team: 1, startsAt: 1 });
rehearsalSchema.index({ status: 1, startsAt: 1 });
rehearsalSchema.index({ sourceAction: 1 }, { unique: true, sparse: true });

export type RehearsalDoc = InferSchemaType<typeof rehearsalSchema>;
export const Rehearsal = model("Rehearsal", rehearsalSchema);
