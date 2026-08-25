import { Types } from "mongoose";
import { Rehearsal } from "../models/Rehearsal";
import { AttendanceStatus, RehearsalResponse } from "../models/RehearsalResponse";
import { Team } from "../models/Team";
import { User } from "../models/User";
import { endOfDay, startOfDay } from "./date-parser.service";

export interface CreateRehearsalInput {
  team: Types.ObjectId | string;
  service?: Types.ObjectId | string;
  startsAt: Date;
  location?: string;
  comment?: string;
  lineup?: Array<{ role: string; slotLabel?: string; displayName?: string; userTelegramId?: number }>;
  createdBy: number;
  sourceAction?: Types.ObjectId | string;
}

export async function createRehearsal(input: CreateRehearsalInput) {
  if (input.startsAt <= new Date()) throw new Error("Нельзя создать репетицию в прошлом");
  return Rehearsal.create(input);
}

export async function listUpcomingRehearsals(teamId: Types.ObjectId | string, limit = 10) {
  return Rehearsal.find({ team: teamId, status: "scheduled", startsAt: { $gt: new Date() } })
    .sort({ startsAt: 1 })
    .limit(limit);
}

export async function getNextRehearsal(teamId: Types.ObjectId | string) {
  return Rehearsal.findOne({ team: teamId, status: "scheduled", startsAt: { $gt: new Date() } }).sort({ startsAt: 1 });
}

export async function getRehearsalsForDay(teamId: Types.ObjectId | string, date: Date) {
  return Rehearsal.find({ team: teamId, status: "scheduled", startsAt: { $gte: startOfDay(date), $lte: endOfDay(date) } }).sort({ startsAt: 1 });
}

export async function findRehearsalForDate(teamId: Types.ObjectId | string, date?: Date | null) {
  if (!date) return getNextRehearsal(teamId);
  return Rehearsal.findOne({
    team: teamId,
    status: "scheduled",
    startsAt: { $gte: startOfDay(date), $lte: endOfDay(date) },
  }).sort({ startsAt: 1 });
}

export async function findRelevantRehearsal(teamId: Types.ObjectId | string, now = new Date()) {
  const until = new Date(now.getTime() + 36 * 60 * 60 * 1000);
  const since = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  return Rehearsal.findOne({ team: teamId, status: "scheduled", startsAt: { $gte: since, $lte: until } }).sort({ startsAt: 1 });
}

export async function moveRehearsal(teamId: Types.ObjectId | string, rehearsalId: Types.ObjectId | string, startsAt: Date, changedBy: number, location?: string) {
  if (startsAt <= new Date()) return null;
  const rehearsal = await Rehearsal.findOne({ _id: rehearsalId, team: teamId, status: "scheduled" });
  if (!rehearsal) return null;
  if (rehearsal.startsAt.getTime() === startsAt.getTime() && (!location || location === rehearsal.location)) return rehearsal;
  const previous = rehearsal.startsAt;
  rehearsal.history.push({ from: previous, to: startsAt, changedBy, changedAt: new Date() });
  rehearsal.startsAt = startsAt;
  if (location !== undefined) rehearsal.location = location;
  rehearsal.reminder24hSent = false;
  rehearsal.reminder2hSent = false;
  await rehearsal.save();
  console.log(`[REHEARSAL] moved id=${rehearsal.id} team=${teamId}`);
  return rehearsal;
}

export async function cancelRehearsal(teamId: Types.ObjectId | string, rehearsalId: Types.ObjectId | string, cancelledBy: number) {
  const rehearsal = await Rehearsal.findOne({ _id: rehearsalId, team: teamId });
  if (!rehearsal) return null;
  if (rehearsal.status === "cancelled") return rehearsal;
  rehearsal.status = "cancelled";
  rehearsal.cancelledBy = cancelledBy;
  rehearsal.cancelledAt = new Date();
  await rehearsal.save();
  console.log(`[REHEARSAL] cancelled id=${rehearsal.id} team=${teamId}`);
  return rehearsal;
}

export async function saveAttendance(teamId: Types.ObjectId | string, rehearsalId: Types.ObjectId | string, telegramId: number, status: AttendanceStatus, lateMinutes?: number) {
  const [team, rehearsal] = await Promise.all([
    Team.exists({ _id: teamId, $or: [{ ownerId: telegramId }, { "members.telegramId": telegramId }] }),
    Rehearsal.exists({ _id: rehearsalId, team: teamId, status: "scheduled" }),
  ]);
  if (!team || !rehearsal) return null;
  const update = {
    $set: { team: teamId, rehearsal: rehearsalId, telegramId, status, ...(status === "late" && lateMinutes ? { lateMinutes } : {}) },
    ...(status === "late" && lateMinutes ? {} : { $unset: { lateMinutes: 1 } }),
  };
  return RehearsalResponse.findOneAndUpdate(
    { rehearsal: rehearsalId, telegramId },
    update,
    { upsert: true, returnDocument: "after" }
  );
}

export async function getAttendanceSummary(teamId: Types.ObjectId | string, rehearsalId: Types.ObjectId | string) {
  const [team, responses] = await Promise.all([
    Team.findById(teamId).lean(),
    RehearsalResponse.find({ team: teamId, rehearsal: rehearsalId }).lean(),
  ]);
  if (!team) return null;
  const ids = [...new Set([...team.members.map((member) => member.telegramId), ...(team.ownerId ? [team.ownerId] : [])])];
  const users = await User.find({ telegramId: { $in: ids } }).select("telegramId fullName firstName username").lean();
  const names = new Map(users.map((user) => [user.telegramId, user.fullName ?? user.firstName ?? user.username ?? String(user.telegramId)]));
  const byStatus = (status: AttendanceStatus) => responses.filter((item) => item.status === status);
  const answered = new Set(responses.map((item) => item.telegramId));
  return {
    attending: byStatus("attending"),
    late: byStatus("late"),
    unavailable: byStatus("unavailable"),
    unanswered: ids.filter((id) => !answered.has(id)),
    name: (id: number) => names.get(id) ?? String(id),
  };
}
