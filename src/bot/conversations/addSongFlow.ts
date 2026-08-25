import { Conversation } from '@grammyjs/conversations'
import { InlineKeyboard } from 'grammy'
import { createSong } from '../../services/songService'
import { upsertUser } from '../../services/teamService'
import { getAdminTeams } from '../../services/teamService'
import { MyContext } from '../context'
import { sendSongCard } from '../views/songCard'

type MyConversation = Conversation<MyContext, MyContext>

async function deleteMessage(ctx: MyContext, messageId?: number): Promise<void> {
  if (!messageId || !ctx.chat) return
  try {
    await ctx.api.deleteMessage(ctx.chat.id, messageId)
  } catch {
    // Старое сообщение или пользовательский ввод могут быть недоступны для удаления.
  }
}

/** Спрашивает текстом, ловит /skip как пропуск необязательного поля */
async function askText(
  conversation: MyConversation,
  ctx: MyContext,
  question: string,
  optional = false
): Promise<string | null> {
  const prompt = await ctx.reply(question + (optional ? '\n\n(если не хочешь заполнять — напиши /skip)' : ''))
  const { message } = await conversation.waitFor('message:text')
  const text = message.text.trim()
  await deleteMessage(ctx, prompt.message_id)
  await deleteMessage(ctx, message.message_id)
  if (optional && text === '/skip') return null
  return text
}

export async function addSongFlow(
  conversation: MyConversation,
  ctx: MyContext,
  initialTeamId?: string,
  originMessageId?: number
) {
  const teams = await conversation.external(async () =>
    (await getAdminTeams(ctx.from!.id)).map((team) => ({
      id: team._id.toString(),
      name: team.name,
    }))
  )

  if (teams.length === 0) {
    await ctx.reply(
      'Пока ни одна группа не привязана к боту. Сначала добавь бота в группу и напиши там /start.'
    )
    return
  }

  // если команда одна — не спрашиваем, сразу берём её
  const requestedTeam = initialTeamId
    ? teams.find((team) => team.id === initialTeamId)
    : undefined
  if (initialTeamId && !requestedTeam) {
    await ctx.reply('Эта команда недоступна для добавления песни.')
    return
  }
  let selectedTeam = requestedTeam ?? teams[0]
  if (!initialTeamId && teams.length > 1) {
    const keyboard = new InlineKeyboard()
    teams.forEach((t) => keyboard.text(t.name, `team:${t.id}`).row())
    await ctx.reply('Для какой команды добавляем песню?', { reply_markup: keyboard })
    const teamQuery = await conversation.waitForCallbackQuery(/^team:/)
    const teamId = teamQuery.callbackQuery.data.split(':')[1]
    await teamQuery.answerCallbackQuery()
    const matchingTeam = teams.find((t) => t.id === teamId)
    if (!matchingTeam) {
      await ctx.reply('Не удалось определить команду. Запусти добавление песни ещё раз.')
      return
    }
    selectedTeam = matchingTeam
  }

  const selectedTeamId = selectedTeam.id
  const selectedTeamName = selectedTeam.name

  const titleResult = await askSongTitle(conversation, ctx)
  if (titleResult.back) return
  await deleteMessage(ctx, originMessageId)
  const title = titleResult.value

  const artist = await askText(conversation, ctx, '🎤 Исполнитель:', true)
  const genre = await askText(conversation, ctx, '🎸 Жанр:', true)

  const key = await askText(conversation, ctx, '🎹 Тональность (напр. G, C#m):', true)
  const chords = await askText(conversation, ctx, '🎼 Аккорды (или ссылка на них):', true)
  const tempoRaw = await askNumber(conversation, ctx, '⏱ Темп в BPM:')
  const timeSignature = await askTimeSignature(conversation, ctx)
  const notes = await askText(conversation, ctx, '📝 Заметки (напр. «капо на 2 ладу»):', true)

  const createdBy = await conversation.external(async () =>
    String((await upsertUser(ctx.from!.id, ctx.from!.first_name, ctx.from!.username))._id)
  )

  const song = await conversation.external(async () => {
    const created = await createSong({
      team: selectedTeamId,
      title: title ?? 'Без названия',
      artist: artist ?? undefined,
      genre: genre ?? undefined,
      key: key ?? undefined,
      chords: chords ?? undefined,
      tempo: tempoRaw ?? undefined,
      timeSignature,
      notes: notes ?? undefined,
      createdBy,
    })
    const plain = created.toObject()
    return {
      title: plain.title,
      artist: plain.artist,
      genre: plain.genre,
      key: plain.key,
      chords: plain.chords,
      timeSignature: plain.timeSignature,
      tempo: plain.tempo,
      notes: plain.notes,
    }
  })

  await ctx.reply(`✅ Песня добавлена в команду «${selectedTeamName}»!`)
  await sendSongCard(ctx, song)
}

async function askSongTitle(
  conversation: MyConversation,
  ctx: MyContext
): Promise<{ back: true } | { back: false; value: string }> {
  const keyboard = new InlineKeyboard().text('⬅️ НАЗАД', 'add-song:back')
  const prompt = await ctx.reply('🎵 Название песни:', { reply_markup: keyboard })
  while (true) {
    const answer = await conversation.wait()
    if (answer.callbackQuery?.data === 'add-song:back') {
      await answer.answerCallbackQuery()
      await deleteMessage(ctx, prompt.message_id)
      return { back: true }
    }
    const value = answer.message?.text?.trim()
    if (value) {
      await deleteMessage(ctx, prompt.message_id)
      await deleteMessage(ctx, answer.message?.message_id)
      return { back: false, value }
    }
    await ctx.reply('Напиши название песни или нажми «Назад».')
  }
}

async function askNumber(conversation: MyConversation, ctx: MyContext, question: string) {
  while (true) {
    const raw = await askText(conversation, ctx, question + ' (только число)', true)
    if (raw === null) return undefined
    const value = Number(raw.replace(',', '.'))
    if (Number.isFinite(value) && value > 0) return value
    await ctx.reply('Нужно положительное число или /skip.')
  }
}

async function askTimeSignature(conversation: MyConversation, ctx: MyContext) {
  while (true) {
    const raw = await askText(conversation, ctx, '🥁 Музыкальный размер (например, 4/4 или 6/8):', true)
    if (raw === null) return undefined
    const normalized = raw.replace(/\s/g, '')
    if (/^[1-9]\d?\/[1-9]\d?$/.test(normalized)) return normalized
    await ctx.reply('Напиши размер в формате 4/4 или 6/8 либо отправь /skip.')
  }
}
