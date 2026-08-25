import { Api, InlineKeyboard } from "grammy";
import { Types } from "mongoose";
import { Team } from "../models/Team";
import { WorshipService } from "../models/WorshipService";

export interface SentTeamMessage {
  chatId: number;
  messageId: number;
}

export async function sendTeamGroupMessage(api: Api, teamId: Types.ObjectId | string, text: string, keyboard?: InlineKeyboard): Promise<SentTeamMessage | null> {
  const team = await Team.findById(teamId).select("telegramChatId chatId").lean();
  const chatId = team?.telegramChatId ?? team?.chatId;
  if (!chatId) return null;
  try {
    const message = await api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return { chatId, messageId: message.message_id };
  } catch (error) {
    console.error(`[NOTIFICATION] failed team=${teamId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function notifyTeamGroup(api: Api, teamId: Types.ObjectId | string, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
  return Boolean(await sendTeamGroupMessage(api, teamId, text, keyboard));
}

export async function pinServiceAnnouncement(api: Api, serviceId: Types.ObjectId | string, chatId: number, messageId: number): Promise<boolean> {
  try {
    await api.pinChatMessage(chatId, messageId, { disable_notification: true });
    await WorshipService.updateOne({ _id: serviceId }, { $set: { announcementChatId: chatId, announcementMessageId: messageId } });
    return true;
  } catch (error) {
    console.warn(`[PIN] failed service=${serviceId}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

export async function unpinServiceAnnouncement(api: Api, serviceId: Types.ObjectId | string): Promise<boolean> {
  const service = await WorshipService.findById(serviceId).select("announcementChatId announcementMessageId").lean();
  if (!service?.announcementChatId || !service.announcementMessageId) return false;
  try {
    await api.unpinChatMessage(service.announcementChatId, service.announcementMessageId);
    await WorshipService.updateOne({ _id: serviceId }, { $unset: { announcementChatId: 1, announcementMessageId: 1 } });
    return true;
  } catch (error) {
    console.warn(`[UNPIN] failed service=${serviceId}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

export async function notifyUser(api: Api, telegramId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
  try {
    await api.sendMessage(telegramId, text, {
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return true;
  } catch (error) {
    console.error(`[NOTIFICATION] user delivery failed telegram_id=${telegramId}:`, error instanceof Error ? error.message : error);
    return false;
  }
}
