import { InferSchemaType, Schema, model } from "mongoose";

export const ATTENDANCE_STATUSES = ["attending", "late", "unavailable"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

const rehearsalResponseSchema = new Schema({
  team: { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
  rehearsal: { type: Schema.Types.ObjectId, ref: "Rehearsal", required: true, index: true },
  telegramId: { type: Number, required: true },
  status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
  lateMinutes: { type: Number, min: 1, max: 600 },
}, { timestamps: true });

rehearsalResponseSchema.index({ rehearsal: 1, telegramId: 1 }, { unique: true });
rehearsalResponseSchema.index({ team: 1, rehearsal: 1 });

export type RehearsalResponseDoc = InferSchemaType<typeof rehearsalResponseSchema>;
export const RehearsalResponse = model("RehearsalResponse", rehearsalResponseSchema);
