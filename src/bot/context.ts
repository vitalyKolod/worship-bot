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
  songSearch?: {
    teamId: string;
    serviceId: string;
    query?: string;
    page: number;
  };
  audioMixer?: { songId: string; enabled: string[]; levels?: Record<string, number>; subdivision?: 1 | 2 | 4; clickSound?: "blip" | "sine"; accentBeat?: number };
  audioSetup?: { songId: string; mode: "timing" | "sections" | "holy_link" | "holy_times" };
}

type BaseContext = Context & TeamContextFlavor & SessionFlavor<SessionData>;
export type MyContext = BaseContext & ConversationFlavor<BaseContext>;
