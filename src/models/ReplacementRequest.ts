import { InferSchemaType, Schema, model } from "mongoose";

const replacementRequestSchema = new Schema({
  team: { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
  service: { type: Schema.Types.ObjectId, ref: "WorshipService", required: true, index: true },
  role: { type: String, required: true },
  currentTelegramId: { type: Number, required: true },
  candidateTelegramId: { type: Number, required: true },
  requestedBy: { type: Number, required: true },
  status: { type: String, enum: ["pending", "accepted", "declined", "cancelled"], default: "pending" },
  respondedAt: Date,
}, { timestamps: true });

replacementRequestSchema.index({ service: 1, role: 1, candidateTelegramId: 1, status: 1 });
replacementRequestSchema.index(
  { service: 1, role: 1, currentTelegramId: 1, candidateTelegramId: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

export type ReplacementRequestDoc = InferSchemaType<typeof replacementRequestSchema>;
export const ReplacementRequest = model("ReplacementRequest", replacementRequestSchema);
