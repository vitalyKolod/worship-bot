import { Schema, model, InferSchemaType } from "mongoose";

const userSchema = new Schema({
  telegramId: { type: Number, required: true, unique: true },
  firstName: String,
  username: String,
  fullName: { type: String, trim: true, maxlength: 100 },
  worshipGroupName: { type: String, trim: true, maxlength: 70 },
  defaultRoles: { type: [String], default: [] },
  customRoles: { type: [String], default: [] },
  registrationStatus: {
    type: String,
    enum: ["none", "in_progress", "done"],
    default: "none",
  },
  registrationStep: {
    type: String,
    enum: ["fio", "worship_group", "roles", "confirm"],
    default: "fio",
  },
  inputMode: {
    type: String,
    enum: ["none", "registration_fio", "registration_group", "registration_custom_role", "create_team", "join_custom_role", "profile_fio", "profile_group", "search_song"],
    default: "none",
  },
  pendingTeamJoinCode: { type: String, default: null },
  pendingJoinRoles: { type: [String], default: [] },
  awaitingAudioSongId: { type: Schema.Types.ObjectId, ref: "Song" },
  pendingSongSearchTeamId: { type: Schema.Types.ObjectId, ref: "Team" },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model("User", userSchema);
