import { Context, SessionFlavor } from "grammy";
import { ConversationFlavor } from "@grammyjs/conversations";
import { TeamContextFlavor } from "./middlewares/teamContext";

export interface PendingSongSelection {
  teamId: string;
  choices: Array<{
    id: string;
    title: string;
    artist?: string;
  }>;
  expiresAt: number;
}

export interface SessionData {
  // В группах одна сессия на чат, поэтому ожидания хранятся отдельно для
  // каждого пользователя, который уточняет найденную песню.
  pendingSongSelections?: Record<string, PendingSongSelection>;
}

type BaseContext = Context & TeamContextFlavor & SessionFlavor<SessionData>;
export type MyContext = BaseContext & ConversationFlavor<BaseContext>;
