import * as cheerio from "cheerio";
import { SectionName } from "./audio-accompaniment.service";

export type ChartSection = { name: SectionName; label: string; weight: number; lyrics?: string[]; variant?: number; draftAt?: number };
const HOSTS = new Set(["holychords.pro", "www.holychords.pro", "holychords.ru", "www.holychords.ru"]);
const LABELS: Record<string, SectionName> = {
  "интро": "Intro", "вступление": "Intro", "куплет": "Verse", "предприпев": "Pre Chorus",
  "припев": "Chorus", "постприпев": "Post Chorus", "бридж": "Bridge", "мост": "Bridge",
  "проигрыш": "Interlude", "интерлюдия": "Interlude", "соло": "Solo", "брейк": "Breakdown",
  "переход": "Turnaround", "концовка": "Outro", "аутро": "Outro", "тэг": "Tag", "вамп": "Vamp",
  "intro": "Intro", "verse": "Verse", "pre chorus": "Pre Chorus", "chorus": "Chorus",
  "bridge": "Bridge", "interlude": "Interlude", "outro": "Outro", "tag": "Tag", "vamp": "Vamp",
};
const CHORD = /^(?:[A-H](?:#|b)?(?:m|maj|min|sus|dim|aug|add)?\d*(?:\/[A-H](?:#|b)?)?)$/;

export function normalizeHolyChordsUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Пришли полную ссылку на песню HolyChords."); }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || !/^\/\d+\/?$/.test(url.pathname)) {
    throw new Error("Поддерживаются только ссылки вида https://holychords.pro/74985.");
  }
  return `https://${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
}

function heading(line: string): { name: SectionName; label: string; variant?: number; repeat: number } | null {
  const cleaned = line.trim().replace(/\s+/g, " ");
  const match = cleaned.replace(/^[\[(]/, "").replace(/[\])]$/, "").match(/^(?:(\d+)\s+)?([\p{L}]+(?:[ -][\p{L}]+)?)(?:\s+(\d+))?\s*:?\s*(?:[xх×]\s*(\d+))?$/iu);
  if (!match) return null;
  const name = LABELS[match[2].toLowerCase()];
  if (!name) return null;
  const variant = Number(match[1] || match[3]) || undefined;
  return { name, label: cleaned.replace(/\s*:\s*$/, ""), variant: variant && variant <= 7 ? variant : undefined, repeat: Math.min(4, Number(match[4]) || 1) };
}

function isChordLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.filter((token) => CHORD.test(token)).length >= Math.ceil(tokens.length * 0.7);
}

export function parseHolyChordsPage(html: Buffer | string): ChartSection[] {
  const $ = Buffer.isBuffer(html) ? cheerio.loadBuffer(html) : cheerio.load(html);
  const chart = $("pre#music_text[itemprop='lyrics']").text();
  if (!chart) throw new Error("На странице не найден текст песни с разделами.");
  const sections: ChartSection[] = [];
  let repeat = 1;
  let chordLines = 0;
  const finish = () => {
    const section = sections[sections.length - 1];
    if (section) section.weight = Math.max(1, (section.lyrics?.length || chordLines || 1) * repeat);
  };
  for (const source of chart.split(/\r?\n/)) {
    const line = source.trim();
    const parsed = heading(line);
    if (parsed) {
      finish();
      sections.push({ name: parsed.name, label: parsed.label, variant: parsed.variant, weight: 1, lyrics: [] });
      repeat = parsed.repeat;
      chordLines = 0;
      continue;
    }
    if (!sections.length || !line) continue;
    if (isChordLine(line)) chordLines++;
    else if (/[\p{L}]{2,}/u.test(line)) sections[sections.length - 1].lyrics!.push(line);
  }
  finish();
  if (sections.length < 2 || sections.length > 50) throw new Error("Не удалось надёжно прочитать последовательность частей песни.");
  return sections;
}

export async function fetchHolyChordsSections(input: string): Promise<{ url: string; sections: ChartSection[] }> {
  const url = normalizeHolyChordsUrl(input);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "WorshipBot/1.0 (+song-structure-import)" } });
  if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/html")) throw new Error("HolyChords не отдал страницу песни. Попробуй другую ссылку.");
  const maxBytes = 1024 * 1024;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Страница HolyChords слишком большая.");
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return { url, sections: parseHolyChordsPage(Buffer.concat(chunks)) };
}
