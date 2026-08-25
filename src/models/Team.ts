import { Schema, model, InferSchemaType } from "mongoose";

const memberSchema = new Schema({
  telegramId: { type: Number, required: true },
  roles: { type: [String], default: [] },
  joinedAt: { type: Date, default: Date.now },
}, { _id: false });

const teamSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 70 },
  ownerId: { type: Number, index: true },
  members: { type: [memberSchema], default: [] },
  telegramChatId: { type: Number },
  telegramChatTitle: String,
  joinCode: { type: String },
  // Legacy-поле сохраняется для уже созданных команд и текущего song flow.
  chatId: { type: Number },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

teamSchema.index({ joinCode: 1 }, { unique: true, sparse: true });
teamSchema.index({ telegramChatId: 1 }, { unique: true, sparse: true });
teamSchema.index({ chatId: 1 }, { unique: true, sparse: true });
teamSchema.index({ "members.telegramId": 1 });

export type TeamDoc = InferSchemaType<typeof teamSchema>;
export const Team = model("Team", teamSchema);
