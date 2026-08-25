export const MESSAGE_INTENTS = [
  "CREATE_REHEARSAL", "MOVE_REHEARSAL", "CANCEL_REHEARSAL", "USER_LATE",
  "USER_UNAVAILABLE", "SET_LINEUP", "MOVE_SERVICE", "UPDATE_SERVICE", "WHAT_TODAY", "USER_ASSIGNMENT", "NONE",
] as const;
export type MessageIntentType = (typeof MESSAGE_INTENTS)[number];

export interface MessageIntent {
  type: MessageIntentType;
  lateMinutes?: number;
}

export const ROLE_DEFINITIONS = [
  { code: "worship_leader", label: "Worship leader", emoji: "🎤", pattern: /worship\s*leader|лидер\s+прославлен|ведущ(?:ий|ая)/iu },
  { code: "vocal", label: "Вокал", emoji: "🎤", pattern: /вокал[а-я]*|бэк[а-я]*/iu },
  { code: "drums", label: "Барабаны", emoji: "🥁", pattern: /барабан[а-я]*|ударн[а-я]*/iu },
  { code: "bass", label: "Бас", emoji: "🎸", pattern: /(?:^|\s)(?:на\s+)?бас(?:у|е|а)?(?=\s|$|[-—:])/iu },
  { code: "acoustic_guitar", label: "Акустика", emoji: "🎸", pattern: /акустик[а-я]*/iu },
  { code: "electric_guitar", label: "Электрогитара", emoji: "🎸", pattern: /электрогитар[а-я]*|электро(?:\s+гитар[а-я]*)?/iu },
  { code: "keys", label: "Клавиши", emoji: "🎹", pattern: /клавиш[а-я]*|клав[а-я]*|фортепиано|пианино/iu },
  { code: "md", label: "MD", emoji: "🎼", pattern: /(?:^|\s)md(?:\s|$)|музыкальн(?:ый|ая)\s+директор/iu },
  { code: "sound", label: "Звук", emoji: "🎚", pattern: /звукореж[а-я]*|(?:^|\s)звук(?=\s|$)/iu },
  { code: "media", label: "Медиа / Слайды", emoji: "🖥", pattern: /медиа|слайд[а-я]*/iu },
  { code: "percussion", label: "Перкуссия", emoji: "🪘", pattern: /перкусси[а-я]*|кахон[а-я]*/iu },
  { code: "violin", label: "Скрипка", emoji: "🎻", pattern: /скрипк[а-я]*/iu },
  { code: "cello", label: "Виолончель", emoji: "🎻", pattern: /виолончел[а-я]*/iu },
  { code: "saxophone", label: "Саксофон", emoji: "🎷", pattern: /саксофон[а-я]*/iu },
  { code: "trumpet", label: "Труба", emoji: "🎺", pattern: /труб(?:а|е|у|ой)/iu },
  { code: "flute", label: "Флейта", emoji: "🪈", pattern: /флейт[а-я]*/iu },
] as const;

const CUSTOM_ROLE_EMOJI: Record<string, { id: string; fallback: string }> = {
  acoustic_guitar: { id: "5408831252780294357", fallback: "🎸" },
  electric_guitar: { id: "5465665777619204788", fallback: "🎸" },
  vocal: { id: "5850483186504568476", fallback: "🎤" },
  keys: { id: "5467398680959023683", fallback: "🎹" },
  drums: { id: "5465293043177388397", fallback: "🥁" },
  bass: { id: "5219879140164908839", fallback: "🎸" },
};

export interface LineupCandidate {
  role: string;
  names: string[];
}

export function parseMessageIntent(text: string): MessageIntent {
  const value = text.trim().toLowerCase().replace(/ё/g, "е");
  if (!value || value.length > 2000) return { type: "NONE" };
  if (/^(?:что\s+(?:у\s+нас\s+)?сегодня|что\s+сегодня)\??$/iu.test(value)) return { type: "WHAT_TODAY" };
  if (/(?:что\s+я\s+играю|я\s+на\s+чем|какой\s+у\s+меня\s+состав)/iu.test(value)) return { type: "USER_ASSIGNMENT" };
  if (/(?:я\s+)?опозд|буду.{0,20}(?:позже|через)|задержусь/iu.test(value)) {
    const minutes = extractLateMinutes(value);
    return { type: "USER_LATE", ...(minutes ? { lateMinutes: minutes } : {}) };
  }
  if (/(?:я\s+)?(?:сегодня|завтра|на\s+репетиц(?:ию|ии))?.{0,24}(?:не\s+смогу|не\s+приду)|меня.{0,30}не\s+будет/iu.test(value)) {
    return { type: "USER_UNAVAILABLE" };
  }
  if (/(?:отмен|не\s+будет)/iu.test(value) && /репетиц|репу|репы|репа/iu.test(value)) return { type: "CANCEL_REHEARSAL" };
  if (/(?:перенес|перенос|вместо)/iu.test(value) && /служен/iu.test(value)) return { type: "MOVE_SERVICE" };
  if (/(?:перенес|перенос|вместо)/iu.test(value) && (/(?:репетиц|репу|репы|репа)/iu.test(value) || /(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|завтра|послезавтра)/iu.test(value))) return { type: "MOVE_REHEARSAL" };
  if (extractLineupCandidates(text).length && /состав|барабан|бас|клавиш|вокал|гитар|звук|перкус|кахон|скрип|виолонч|саксоф|труб|флейт/iu.test(value)) return { type: "SET_LINEUP" };
  if (/^давайте\s+в\s+(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)/iu.test(value)) return { type: "CREATE_REHEARSAL" };
  if (/репетиц|репу|репа/iu.test(value) && /сегодня|завтра|послезавтра|понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|\d{1,2}[./]|\d{1,2}\s+[а-я]/iu.test(value)) {
    return { type: "CREATE_REHEARSAL" };
  }
  return { type: "NONE" };
}

export function extractLateMinutes(text: string): number | undefined {
  if (/полчас/iu.test(text)) return 30;
  const match = text.match(/(?:на|минут\s+на|через)\s*(\d{1,3})\s*(?:мин|м\b)?/iu);
  const minutes = match ? Number(match[1]) : 0;
  return minutes >= 1 && minutes <= 600 ? minutes : undefined;
}

export function extractLineupCandidates(text: string): LineupCandidate[] {
  const entries: LineupCandidate[] = [];
  const chunks = text.split(/\n|;/u).map((item) => item.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const definition = ROLE_DEFINITIONS.find((item) => item.pattern.test(chunk));
    if (!definition) continue;
    const roleMatch = chunk.match(definition.pattern);
    const afterRole = roleMatch ? chunk.slice((roleMatch.index ?? 0) + roleMatch[0].length) : "";
    const cleaned = afterRole.replace(/^[\s:—–-]+/u, "").replace(/[.!?]+$/u, "").trim();
    const names = cleaned.split(/\s+(?:и|&)\s+|,/iu).map((name) => name.trim()).filter((name) => name.length >= 2);
    if (names.length) entries.push({ role: definition.code, names });
  }
  return entries;
}

export function rolePresentation(role: string): { label: string; emoji: string } {
  const definition = ROLE_DEFINITIONS.find((item) => item.code === role);
  return definition ? { label: definition.label, emoji: definition.emoji } : { label: role, emoji: "🎵" };
}

/** HTML для сообщений с parse_mode=HTML. В кнопках используй обычный rolePresentation().emoji. */
export function roleIconHtml(role: string): string {
  const custom = CUSTOM_ROLE_EMOJI[role];
  return custom ? `<tg-emoji emoji-id="${custom.id}">${custom.fallback}</tg-emoji>` : rolePresentation(role).emoji;
}
