import { InferSchemaType, Schema, model } from "mongoose";

export const ACTION_TYPES = ["create_rehearsal", "move_rehearsal", "cancel_rehearsal", "move_service", "set_lineup"] as const;

const pendingActionSchema = new Schema({
  team: { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
  actorTelegramId: { type: Number, required: true },
  type: { type: String, enum: ACTION_TYPES, required: true },
  status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending", index: true },
  summary: { type: String, required: true, maxlength: 1000 },
  payload: { type: Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
  confirmedBy: Number,
  confirmedAt: Date,
}, { timestamps: true });

pendingActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
pendingActionSchema.index({ team: 1, status: 1, createdAt: -1 });

export type PendingActionDoc = InferSchemaType<typeof pendingActionSchema>;
export const PendingAction = model("PendingAction", pendingActionSchema);
