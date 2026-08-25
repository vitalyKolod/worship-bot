import { Api } from "grammy";

type ChatMember = Awaited<ReturnType<Api["getChatMember"]>>;

export function isTelegramGroupMember(member: ChatMember): boolean {
  if (["creator", "administrator", "member"].includes(member.status)) return true;
  return member.status === "restricted" && member.is_member;
}

export function isTelegramGroupAdmin(member: ChatMember): boolean {
  return member.status === "creator" || member.status === "administrator";
}

export async function checkTelegramGroupMembership(
  api: Api,
  chatId: number,
  telegramId: number
): Promise<"member" | "not_member" | "unavailable"> {
  try {
    const member = await api.getChatMember(chatId, telegramId);
    return isTelegramGroupMember(member) ? "member" : "not_member";
  } catch {
    return "unavailable";
  }
}
