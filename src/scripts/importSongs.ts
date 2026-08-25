import "dotenv/config";
import mongoose, { Types } from "mongoose";
import { INITIAL_SONGS, SOURCE_CLEANUP_NOTES } from "../data/initialSongs";
import { Song } from "../models/Song";
import { Team } from "../models/Team";

interface ImportOptions {
  commit: boolean;
  teamId?: string;
  teamName?: string;
  chatId?: number;
  help: boolean;
}

export function normalizeSongTitle(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .trim();
}

function readOptionValue(args: string[], index: number, name: string): [string, number] {
  const argument = args[index];
  const inlinePrefix = `${name}=`;
  if (argument.startsWith(inlinePrefix)) return [argument.slice(inlinePrefix.length), index];
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`После ${name} нужно указать значение.`);
  return [value, index + 1];
}

export function parseImportOptions(args: string[]): ImportOptions {
  const options: ImportOptions = { commit: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--commit") {
      options.commit = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--team-id" || argument.startsWith("--team-id=")) {
      const [value, consumedIndex] = readOptionValue(args, index, "--team-id");
      options.teamId = value.trim();
      index = consumedIndex;
    } else if (argument === "--team-name" || argument.startsWith("--team-name=")) {
      const [value, consumedIndex] = readOptionValue(args, index, "--team-name");
      options.teamName = value.trim();
      index = consumedIndex;
    } else if (argument === "--chat-id" || argument.startsWith("--chat-id=")) {
      const [value, consumedIndex] = readOptionValue(args, index, "--chat-id");
      const chatId = Number(value);
      if (!Number.isSafeInteger(chatId)) throw new Error("--chat-id должен быть целым числом.");
      options.chatId = chatId;
      index = consumedIndex;
    } else {
      throw new Error(`Неизвестный аргумент: ${argument}`);
    }
  }

  const selectors = [options.teamId, options.teamName, options.chatId].filter(
    (value) => value !== undefined
  );
  if (selectors.length > 1) {
    throw new Error("Укажи только один селектор команды: --team-id, --team-name или --chat-id.");
  }
  return options;
}

function printHelp(): void {
  console.log(`Массовый импорт песен

Использование:
  npm run import:songs
  npm run import:songs -- --team-name "Название команды"
  npm run import:songs -- --team-name "Название команды" --commit

Селектор команды (один из):
  --team-name <название>  точное название без учёта регистра
  --team-id <ObjectId>    MongoDB id команды
  --chat-id <число>       Telegram id уже подключённой группы

Без --commit скрипт только показывает план и ничего не записывает.`);
}

async function listTeams(): Promise<void> {
  const teams = await Team.find()
    .select("name telegramChatId chatId telegramChatTitle")
    .sort({ name: 1 })
    .lean();
  if (teams.length === 0) {
    console.log("Команд пока нет. Сначала создай команду в боте и подключи Telegram-группу через /setup.");
    return;
  }

  console.log("Доступные команды:");
  for (const team of teams) {
    const chatId = team.telegramChatId ?? team.chatId;
    const connection = chatId === undefined ? "не подключена" : `chat id ${chatId}`;
    console.log(`- ${team.name} | id ${team._id} | ${connection}`);
  }
  console.log("\nПовтори команду с --team-name, --team-id или --chat-id. Сначала без --commit.");
}

async function resolveTeam(options: ImportOptions) {
  if (options.teamId) {
    if (!Types.ObjectId.isValid(options.teamId)) throw new Error("Некорректный --team-id.");
    const team = await Team.findById(options.teamId);
    if (!team) throw new Error("Команда с таким --team-id не найдена.");
    return team;
  }

  if (options.chatId !== undefined) {
    const team = await Team.findOne({
      $or: [{ telegramChatId: options.chatId }, { chatId: options.chatId }],
    });
    if (!team) throw new Error("К этому --chat-id не подключена команда.");
    return team;
  }

  if (!options.teamName) throw new Error("Не указан селектор команды.");
  const escapedName = options.teamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const teams = await Team.find({ name: { $regex: `^${escapedName}$`, $options: "i" } });
  if (teams.length === 0) throw new Error(`Команда «${options.teamName}» не найдена.`);
  if (teams.length > 1) {
    throw new Error(`Найдено несколько команд «${options.teamName}». Используй --team-id.`);
  }
  return teams[0];
}

async function importSongs(options: ImportOptions): Promise<void> {
  const team = await resolveTeam(options);
  const existingSongs = await Song.find({ team: team._id }).select("title").lean();
  const existingTitles = new Set(existingSongs.map((item) => normalizeSongTitle(item.title)));
  const songsToAdd = INITIAL_SONGS.filter(
    (item) => !existingTitles.has(normalizeSongTitle(item.title))
  );

  console.log(`Команда: ${team.name} (${team._id})`);
  console.log(`В исходном каталоге: ${INITIAL_SONGS.length}`);
  console.log(`Уже есть в базе: ${INITIAL_SONGS.length - songsToAdd.length}`);
  console.log(`Будет добавлено: ${songsToAdd.length}`);

  if (songsToAdd.length === 0) {
    console.log("Добавлять нечего — каталог уже импортирован.");
    return;
  }

  if (!options.commit) {
    console.log("\nПроверка без записи. Первые 10 новых песен:");
    for (const item of songsToAdd.slice(0, 10)) {
      console.log(`- ${item.title} | ${item.tempo ?? "темп не указан"} | ${item.key} | 4/4`);
    }
    console.log("\nЧто было очищено в исходном списке:");
    for (const note of SOURCE_CLEANUP_NOTES) console.log(`- ${note}`);
    console.log("\nЕсли всё верно, повтори ту же команду с --commit.");
    return;
  }

  const result = await Song.bulkWrite(
    songsToAdd.map((item) => ({
      updateOne: {
        filter: { team: team._id, title: item.title },
        update: { $setOnInsert: { team: team._id, ...item } },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  console.log(`✅ Импорт завершён. Добавлено: ${result.upsertedCount}.`);
  if (result.matchedCount > 0) {
    console.log(`Пропущено из-за одновременного/повторного запуска: ${result.matchedCount}.`);
  }
}

async function main(): Promise<void> {
  const options = parseImportOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri) throw new Error("В .env отсутствует MONGODB_URI.");

  await mongoose.connect(mongodbUri);
  if (!options.teamId && !options.teamName && options.chatId === undefined) {
    await listTeams();
    return;
  }
  await importSongs(options);
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Импорт не выполнен: ${message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect();
    });
}

