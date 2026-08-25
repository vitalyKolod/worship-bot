import { Types } from "mongoose";
import { Song } from "../models/Song";
import { Team } from "../models/Team";
import { User } from "../models/User";
import { WorshipService } from "../models/WorshipService";
import { Rehearsal } from "../models/Rehearsal";
import { endOfDay, startOfDay } from "./date-parser.service";

export async function createWorshipService(input: {
  team: Types.ObjectId | string;
  startsAt: Date;
  soundcheckAt?: Date;
  location?: string;
  title?: string;
  lineup?: Array<{ role: string; slotLabel?: string; displayName?: string; userTelegramId?: number }>;
  setlist?: Array<{ song: Types.ObjectId | string; order: number; section?: "main" | "transition" | "offering"; key?: string; bpm?: number; comment?: string }>;
  createdBy: number;
}) {
  if (input.startsAt <= new Date()) throw new Error("Нельзя создать служение в прошлом");
  return WorshipService.create(input);
}

export async function getNextWorshipService(teamId: Types.ObjectId | string, after = new Date()) {
  return WorshipService.findOne({ team: teamId, status: "scheduled", startsAt: { $gt: after } }).sort({ startsAt: 1 });
}

export async function listUpcomingServices(teamId: Types.ObjectId | string, limit = 10) {
  return WorshipService.find({ team: teamId, status: "scheduled", startsAt: { $gt: new Date() } }).sort({ startsAt: 1 }).limit(limit);
}

export async function moveWorshipService(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, startsAt: Date, changedBy: number, location?: string) {
  if (startsAt <= new Date()) return null;
  const service = await WorshipService.findOne({ _id: serviceId, team: teamId, status: "scheduled" });
  if (!service) return null;
  const soundcheckOffset = service.soundcheckAt ? service.startsAt.getTime() - service.soundcheckAt.getTime() : null;
  service.history.push({ from: service.startsAt, to: startsAt, changedBy, changedAt: new Date() });
  service.startsAt = startsAt;
  if (soundcheckOffset !== null) service.soundcheckAt = new Date(startsAt.getTime() - soundcheckOffset);
  if (location !== undefined) service.location = location;
  await service.save();
  console.log(`[SERVICE] moved id=${service.id} team=${teamId}`);
  return service;
}

export async function cancelWorshipService(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, cancelledBy: number) {
  const service = await WorshipService.findOne({ _id: serviceId, team: teamId });
  if (!service) return null;
  if (service.status === "cancelled") return service;
  service.status = "cancelled";
  service.cancelledBy = cancelledBy;
  service.cancelledAt = new Date();
  await service.save();
  console.log(`[SERVICE] cancelled id=${service.id} team=${teamId}`);
  return service;
}

export async function getServicesForDay(teamId: Types.ObjectId | string, date: Date) {
  return WorshipService.find({ team: teamId, status: "scheduled", startsAt: { $gte: startOfDay(date), $lte: endOfDay(date) } }).sort({ startsAt: 1 });
}

export async function replaceLineupAssignments(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, assignments: Array<{ role: string; slotLabel?: string; displayName?: string; userTelegramId?: number }>) {
  const service = await WorshipService.findOne({ _id: serviceId, team: teamId, status: "scheduled" });
  if (!service) return null;
  const team = await Team.findById(teamId).lean();
  const memberIds = new Set([...(team?.members.map((member) => member.telegramId) ?? []), ...(team?.ownerId ? [team.ownerId] : [])]);
  const roles = new Set(assignments.map((item) => item.role));
  if (assignments.some((item) => item.userTelegramId !== undefined && !memberIds.has(item.userTelegramId))) return null;
  service.set("lineup", [
    ...service.lineup.filter((item) => !roles.has(item.role)),
    ...assignments,
  ]);
  await service.save();
  await Rehearsal.updateMany({ service: service._id, status: "scheduled" }, { $set: { lineup: service.lineup } });
  console.log(`[LINEUP] updated service=${service.id} team=${teamId}`);
  return service;
}

export async function addLineupMember(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, role: string, telegramId: number) {
  const member = await Team.exists({ _id: teamId, $or: [{ ownerId: telegramId }, { "members.telegramId": telegramId }] });
  if (!member) return null;
  const updated = await WorshipService.findOneAndUpdate(
    { _id: serviceId, team: teamId, status: "scheduled", lineup: { $not: { $elemMatch: { role, userTelegramId: telegramId } } } },
    { $push: { lineup: { role, userTelegramId: telegramId } } },
    { returnDocument: "after" }
  );
  const service = updated ?? await WorshipService.findOne({ _id: serviceId, team: teamId });
  if (service) await Rehearsal.updateMany({ service: service._id, status: "scheduled" }, { $set: { lineup: service.lineup } });
  return service;
}

export async function removeLineupMember(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, role: string, telegramId: number) {
  const service = await WorshipService.findOneAndUpdate(
    { _id: serviceId, team: teamId },
    { $pull: { lineup: { role, userTelegramId: telegramId } } },
    { returnDocument: "after" }
  );
  if (service) await Rehearsal.updateMany({ service: service._id, status: "scheduled" }, { $set: { lineup: service.lineup } });
  return service;
}

export async function getLineupNames(serviceId: Types.ObjectId | string) {
  const service = await WorshipService.findById(serviceId).lean();
  if (!service) return null;
  const ids = [...new Set(service.lineup.map((item) => item.userTelegramId).filter((id): id is number => id !== undefined && id !== null))];
  const users = await User.find({ telegramId: { $in: ids } }).select("telegramId fullName firstName username").lean();
  const names = new Map(users.map((user) => [user.telegramId, user.fullName ?? user.firstName ?? user.username ?? String(user.telegramId)]));
  return { service, lineup: service.lineup.map((item) => ({ ...item, name: item.displayName ?? (item.userTelegramId ? names.get(item.userTelegramId) : undefined) ?? "Не указано" })) };
}

export async function addSetlistSong(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, songId: Types.ObjectId | string) {
  const [service, song] = await Promise.all([
    WorshipService.findOne({ _id: serviceId, team: teamId, status: "scheduled" }),
    Song.findOne({ _id: songId, team: teamId }),
  ]);
  if (!service || !song) return null;
  if (service.setlist.some((item) => String(item.song) === String(songId))) return service;
  service.setlist.push({ song: song._id, order: service.setlist.length + 1, key: song.key, bpm: song.tempo });
  await service.save();
  return service;
}

export async function removeSetlistSong(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, songId: Types.ObjectId | string) {
  const service = await WorshipService.findOne({ _id: serviceId, team: teamId });
  if (!service) return null;
  service.set("setlist", service.setlist.filter((item) => String(item.song) !== String(songId)));
  service.setlist.forEach((item, index) => { item.order = index + 1; });
  await service.save();
  return service;
}

export async function moveSetlistSong(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, songId: Types.ObjectId | string, direction: -1 | 1) {
  const service = await WorshipService.findOne({ _id: serviceId, team: teamId });
  if (!service) return null;
  const ordered = [...service.setlist].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((item) => String(item.song) === String(songId));
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ordered.length) return service;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  ordered.forEach((item, itemIndex) => { item.order = itemIndex + 1; });
  service.set("setlist", ordered);
  await service.save();
  return service;
}

export async function updateSetlistKey(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string, songId: Types.ObjectId | string, key: string) {
  return WorshipService.findOneAndUpdate(
    { _id: serviceId, team: teamId, "setlist.song": songId },
    { $set: { "setlist.$.key": key } },
    { returnDocument: "after" }
  );
}

export async function getSetlist(serviceId: Types.ObjectId | string) {
  return WorshipService.findById(serviceId).populate("setlist.song", "title artist key tempo");
}

export async function replaceSetlist(
  teamId: Types.ObjectId | string,
  serviceId: Types.ObjectId | string,
  setlist: Array<{ song: Types.ObjectId | string; order: number; section?: "main" | "transition" | "offering"; key?: string; bpm?: number; comment?: string }>
) {
  return WorshipService.findOneAndUpdate(
    { _id: serviceId, team: teamId, status: "scheduled" },
    { $set: { setlist } },
    { returnDocument: "after" }
  );
}

export async function completeWorshipService(teamId: Types.ObjectId | string, serviceId: Types.ObjectId | string) {
  return WorshipService.findOneAndUpdate(
    { _id: serviceId, team: teamId, status: "scheduled" },
    { $set: { status: "completed" } },
    { returnDocument: "after" }
  );
}
