import { Types } from "mongoose";
import { Team } from "../models/Team";
import { User } from "../models/User";
import { TeamMember, Role } from "../models/TeamMember";
import { env } from "../config/env";
import { randomBytes } from "node:crypto";

/** Находит команду по chatId группы, либо null если бот ещё не привязан к этой группе */
export async function getTeamByChatId(chatId: number) {
  return Team.findOne({ $or: [{ telegramChatId: chatId }, { chatId }] });
}

/** Регистрирует группу как команду при первом /start в группе (делает это тот, кто вызвал) */
export async function registerTeamForChat(chatId: number, name: string) {
  const existing = await getTeamByChatId(chatId);
  if (existing) return existing;
  return Team.create({ name, chatId });
}

export async function getTeamByJoinCode(joinCode: string) {
  return Team.findOne({ joinCode: joinCode.toUpperCase() });
}

export async function getTeamsForUser(telegramId: number) {
  return Team.find({
    $or: [{ ownerId: telegramId }, { "members.telegramId": telegramId }],
  }).sort({ name: 1 });
}

export async function getOwnedUnlinkedTeams(telegramId: number) {
  return Team.find({
    ownerId: telegramId,
    telegramChatId: { $exists: false },
    chatId: { $exists: false },
  }).sort({ name: 1 });
}

export async function getAccessibleTeam(teamId: string, telegramId: number) {
  if (!Types.ObjectId.isValid(teamId)) return null;
  return Team.findOne({
    _id: teamId,
    $or: [{ ownerId: telegramId }, { "members.telegramId": telegramId }],
  });
}

async function generateUniqueJoinCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomBytes(5).toString("base64url").slice(0, 8).toUpperCase();
    if (!(await Team.exists({ joinCode: code }))) return code;
  }
  throw new Error("Не удалось создать уникальный код приглашения");
}

/** Идемпотентно дополняет Team, созданные старым group /start.
 * Источником owner служит только уже существующая admin-запись TeamMember. */
export async function migrateLegacyTeams(): Promise<void> {
  const legacyTeams = await Team.find({ ownerId: { $exists: false } });
  for (const team of legacyTeams) {
    const adminMembership = await TeamMember.findOne({ team: team._id, role: "admin" });
    if (!adminMembership) continue;
    const owner = await User.findById(adminMembership.user);
    if (!owner) continue;
    await Team.updateOne(
      { _id: team._id, ownerId: { $exists: false } },
      {
        $set: {
          ownerId: owner.telegramId,
          members: [{
            telegramId: owner.telegramId,
            roles: owner.defaultRoles,
            joinedAt: adminMembership._id.getTimestamp(),
          }],
          joinCode: team.joinCode ?? await generateUniqueJoinCode(),
          ...(team.chatId ? {
            telegramChatId: team.chatId,
            telegramChatTitle: team.telegramChatTitle ?? team.name,
          } : {}),
        },
      }
    );
  }
}

export async function createWorshipTeam(name: string, telegramId: number, roles: string[]) {
  const user = await User.findOne({ telegramId, registrationStatus: "done" });
  if (!user) throw new Error("Для создания команды нужно завершить регистрацию");
  const team = await Team.create({
    name: name.trim(),
    ownerId: telegramId,
    members: [{ telegramId, roles, joinedAt: new Date() }],
    joinCode: await generateUniqueJoinCode(),
  });
  await addMemberToTeam(team._id, telegramId, "admin");
  return team;
}

export async function connectTeamToChat(
  teamId: string,
  ownerId: number,
  telegramChatId: number,
  telegramChatTitle: string
) {
  if (!Types.ObjectId.isValid(teamId)) return null;
  const occupied = await getTeamByChatId(telegramChatId);
  if (occupied && String(occupied._id) !== teamId) return null;
  return Team.findOneAndUpdate(
    {
      _id: teamId,
      ownerId,
      telegramChatId: { $exists: false },
      chatId: { $exists: false },
    },
    { $set: { telegramChatId, telegramChatTitle } },
    { returnDocument: "after" }
  );
}

export async function addWorshipTeamMember(teamId: string, telegramId: number, roles: string[]) {
  if (!Types.ObjectId.isValid(teamId)) return null;
  const team = await Team.findOneAndUpdate(
    { _id: teamId, "members.telegramId": { $ne: telegramId } },
    { $push: { members: { telegramId, roles, joinedAt: new Date() } } },
    { returnDocument: "after" }
  );
  const existing = team ?? await Team.findById(teamId);
  if (existing) await addMemberToTeam(existing._id, telegramId, "member");
  return existing;
}

/** Находит или создаёт пользователя по данным из Telegram */
export async function upsertUser(telegramId: number, firstName?: string, username?: string) {
  return User.findOneAndUpdate(
    { telegramId },
    { telegramId, firstName, username },
    { upsert: true, returnDocument: "after" }
  );
}

/** Проверяет, является ли пользователь админом в конкретной команде (или супер-админом из .env) */
export async function isAdmin(telegramId: number, teamId?: Types.ObjectId | string): Promise<boolean> {
  if (env.superAdminIds.includes(telegramId)) return true;
  if (teamId && await Team.exists({ _id: teamId, ownerId: telegramId })) return true;
  const user = await User.findOne({ telegramId });
  if (!user) return false;

  const membership = await TeamMember.findOne({
    ...(teamId ? { team: teamId } : {}),
    user: user._id,
    role: { $in: ["admin", "leader"] },
  });
  return membership?.role === "admin" || membership?.role === "leader";
}

export async function getAdminTeams(telegramId: number) {
  // Conversation results are serialized between updates, so return plain objects
  // instead of Mongoose documents with prototype-backed properties such as `_id`.
  if (env.superAdminIds.includes(telegramId)) return Team.find().sort({ name: 1 }).lean();
  const user = await User.findOne({ telegramId });
  if (!user) return [];
  const memberships = await TeamMember.find({ user: user._id, role: { $in: ["admin", "leader"] } }).select("team");
  return Team.find({ _id: { $in: memberships.map((item) => item.team) } })
    .sort({ name: 1 })
    .lean();
}

/** Добавляет пользователя в команду с ролью (по умолчанию member) */
export async function addMemberToTeam(teamId: Types.ObjectId | string, telegramId: number, role: Role = "member") {
  const user = await upsertUser(telegramId);
  return TeamMember.findOneAndUpdate(
    { team: teamId, user: user._id },
    { role },
    { upsert: true, returnDocument: "after" }
  );
}
