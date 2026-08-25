import { Types } from "mongoose";
import { Song, Mood } from "../models/Song";

export interface CreateSongInput {
  team: Types.ObjectId | string;
  title: string;
  artist?: string;
  genre?: string;
  mood?: Mood;
  key?: string;
  chords?: string;
  timeSignature?: string;
  tempo?: number;
  notes?: string;
  createdBy?: Types.ObjectId | string;
}

export async function createSong(input: CreateSongInput) {
  return Song.create(input);
}

/** Ищет песни в команде по названию/исполнителю. Сначала точное совпадение по началу строки,
 *  потом — полнотекстовый поиск, чтобы находить даже при опечатках/неполном названии. */
export async function findSongsInTeam(teamId: Types.ObjectId | string, query: string) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const prefixMatch = await Song.find({
    team: teamId,
    $or: [
      { title: { $regex: escapeRegex(normalizedQuery), $options: "i" } },
      { artist: { $regex: escapeRegex(normalizedQuery), $options: "i" } },
    ],
  }).limit(5);

  if (prefixMatch.length > 0) return prefixMatch;

  const textMatches = await Song.find(
    { team: teamId, $text: { $search: normalizedQuery } },
    { score: { $meta: "textScore" } }
  )
    .sort({ score: { $meta: "textScore" } })
    .limit(5);
  if (textMatches.length > 0) return textMatches;

  // MongoDB text search не исправляет опечатки. Для небольшой командной базы
  // надёжнее ранжировать названия в приложении и вернуть близкие варианты.
  const songs = await Song.find({ team: teamId }).limit(500);
  const queryKey = normalizeForFuzzySearch(normalizedQuery);
  return songs
    .map((song) => {
      const title = normalizeForFuzzySearch(song.title);
      const artist = normalizeForFuzzySearch(song.artist ?? "");
      return { song, score: scoreSongMatch(queryKey, title, artist) };
    })
    .filter(({ score }) => score <= 0.55)
    .sort((left, right) => left.score - right.score)
    .slice(0, 5)
    .map(({ song }) => song);
}

export async function listSongsInTeam(teamId: Types.ObjectId | string) {
  return Song.find({ team: teamId }).sort({ title: 1 });
}

export async function updateSong(
  teamId: Types.ObjectId | string,
  songId: Types.ObjectId | string,
  input: Partial<Omit<CreateSongInput, "team" | "createdBy">>
) {
  return Song.findOneAndUpdate(
    { _id: songId, team: teamId },
    { $set: input },
    { returnDocument: "after" }
  );
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForFuzzySearch(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/giu, " ").trim();
}

export function scoreSongMatch(query: string, title: string, artist = ""): number {
  const queryKey = normalizeForFuzzySearch(query);
  const titleKey = normalizeForFuzzySearch(title);
  const artistKey = normalizeForFuzzySearch(artist);
  const titleScore = fuzzyScore(queryKey, titleKey);
  const artistScore = artistKey ? fuzzyScore(queryKey, artistKey) + 0.15 : Number.POSITIVE_INFINITY;
  return Math.min(titleScore, artistScore);
}

function fuzzyScore(query: string, candidate: string): number {
  if (!query || !candidate) return Number.POSITIVE_INFINITY;
  if (candidate.includes(query)) return 0;
  const queryWords = query.split(" ");
  const candidateWords = candidate.split(" ");
  const wordScore = queryWords.reduce((total, word) => {
    const best = Math.min(...candidateWords.map((candidateWord) => normalizedDistance(word, candidateWord)));
    return total + best;
  }, 0) / queryWords.length;
  return Math.min(wordScore, normalizedDistance(query, candidate));
}

function normalizedDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    let diagonal = rows[0];
    rows[0] = rightIndex;
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const previous = rows[leftIndex];
      rows[leftIndex] = Math.min(
        rows[leftIndex] + 1,
        rows[leftIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = previous;
    }
  }
  return rows[left.length] / Math.max(left.length, right.length, 1);
}
