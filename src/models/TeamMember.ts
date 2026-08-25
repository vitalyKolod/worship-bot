import { Schema, model, Types, InferSchemaType } from "mongoose";

export const ROLES = ["admin", "leader", "musician", "member"] as const;
export type Role = (typeof ROLES)[number];

const teamMemberSchema = new Schema({
  team: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  role: { type: String, enum: ROLES, default: "member" },
});

// один пользователь — одна роль в рамках одной команды
teamMemberSchema.index({ team: 1, user: 1 }, { unique: true });

export type TeamMemberDoc = InferSchemaType<typeof teamMemberSchema>;
export const TeamMember = model("TeamMember", teamMemberSchema);
