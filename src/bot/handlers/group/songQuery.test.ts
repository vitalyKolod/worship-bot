import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractSongQueryFromText,
  formatSong,
  hasSongQuestionKeyword,
  isKeyQuestion,
  isSongListQuestion,
  resolveSongChoice,
} from './songQuery'

test('detects tone and chord questions', () => {
  assert.equal(hasSongQuestionKeyword('Какая тональность у песни Восхваление?'), true)
  assert.equal(hasSongQuestionKeyword('Какие аккорды у песни Jesus?'), true)
  assert.equal(hasSongQuestionKeyword('Какой размер у песни Jesus?'), true)
  assert.equal(hasSongQuestionKeyword('Кто поёт Благодать?'), true)
  assert.equal(hasSongQuestionKeyword('Как играем Way Maker?'), true)
  assert.equal(hasSongQuestionKeyword('Привет, как дела?'), false)
})

test('extracts the song title from a natural-language question', () => {
  assert.equal(extractSongQueryFromText('Какая тональность у песни Восхваление?'), 'восхваление')
  assert.equal(extractSongQueryFromText('Какие аккорды у песни Jesus?'), 'jesus')
  assert.equal(extractSongQueryFromText('В какой тональности мы играем Благодать?'), 'благодать')
  assert.equal(extractSongQueryFromText('Тональность у Way Maker?'), 'way maker')
  assert.equal(extractSongQueryFromText('Кто поёт Благодать?'), 'благодать')
  assert.equal(extractSongQueryFromText('Как играем Way Maker?'), 'way maker')
})

test('recognizes requests for the local song list', () => {
  assert.equal(isSongListQuestion('Какие песни у нас есть?'), true)
  assert.equal(isSongListQuestion('Покажи все песни в базе'), true)
  assert.equal(isSongListQuestion('Эта песня отличная'), false)
})

test('recognizes a key question without requiring a bot mention', () => {
  assert.equal(isKeyQuestion('В какой тональности играем Благодать?'), true)
  assert.equal(isKeyQuestion('Какие песни играем в воскресенье?'), false)
})

test('formatSong builds a compact song card', () => {
  const text = formatSong({
    title: 'Jesus',
    artist: 'Chris Tomlin',
    key: 'G',
    chords: 'G - D - Em - C',
    timeSignature: '6/8',
  } as any)

  assert.match(text, /Аккорды:<\/b> G - D - Em - C/)
  assert.match(text, /Размер:<\/b> 6\/8/)
})

test('resolves an ambiguous search by exact title or number', () => {
  const choices = [
    { id: '1', title: 'Славь, душа, Господа' },
    { id: '2', title: 'Славь' },
    { id: '3', title: 'Славьте Бога' },
  ]

  assert.equal(resolveSongChoice('Славь', choices)?.id, '2')
  assert.equal(resolveSongChoice('1', choices)?.id, '1')
  assert.equal(resolveSongChoice('славьте', choices)?.id, '3')
  assert.equal(resolveSongChoice('другая песня', choices), undefined)
})
