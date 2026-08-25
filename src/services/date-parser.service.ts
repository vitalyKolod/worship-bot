const MONTHS: Record<string, number> = {
  январ: 0, феврал: 1, март: 2, апрел: 3, ма: 4, июн: 5,
  июл: 6, август: 7, сентябр: 8, октябр: 9, ноябр: 10, декабр: 11,
};

const WEEKDAYS: Array<[RegExp, number]> = [
  [/понедельник/iu, 1], [/вторник/iu, 2], [/сред(?:а|у|е)/iu, 3],
  [/четверг/iu, 4], [/пятниц(?:а|у|е)/iu, 5], [/суббот(?:а|у|е)/iu, 6],
  [/воскресень(?:е|я|ю)/iu, 0],
];

export interface ParsedTime {
  hours: number;
  minutes: number;
  ambiguous: boolean;
}

export interface ParsedDateTime {
  value: Date;
  ambiguousTime: boolean;
}

export function startOfDay(value: Date): Date {
  const result = new Date(value);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfDay(value: Date): Date {
  const result = new Date(value);
  result.setHours(23, 59, 59, 999);
  return result;
}

export function parseRussianDate(text: string, now = new Date()): Date | null {
  const normalized = text.toLowerCase().replace(/ё/g, "е");
  const base = startOfDay(now);
  if (/послезавтра/iu.test(normalized)) {
    base.setDate(base.getDate() + 2);
    return base;
  }
  if (/завтра/iu.test(normalized)) {
    base.setDate(base.getDate() + 1);
    return base;
  }
  if (/сегодня/iu.test(normalized)) return base;

  const numeric = normalized.match(/(?:^|\s)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=\s|$)/u);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]) - 1;
    let year = numeric[3] ? Number(numeric[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    const result = new Date(year, month, day);
    if (!numeric[3] && endOfDay(result) < now) result.setFullYear(result.getFullYear() + 1);
    return isValidCalendarDate(result, day, month, result.getFullYear()) ? startOfDay(result) : null;
  }

  const named = normalized.match(/(?:^|\s)(\d{1,2})\s+(январ[яь]?|феврал[яь]?|марта?|апрел[яь]?|ма[яй]|июн[яь]?|июл[яь]?|август[а]?|сентябр[яь]?|октябр[яь]?|ноябр[яь]?|декабр[яь]?)(?:\s+(\d{4}))?/u);
  if (named) {
    const day = Number(named[1]);
    const root = Object.keys(MONTHS).find((item) => named[2].startsWith(item));
    if (!root) return null;
    const month = MONTHS[root];
    const explicitYear = named[3] ? Number(named[3]) : undefined;
    const year = explicitYear ?? now.getFullYear();
    const result = new Date(year, month, day);
    if (!explicitYear && endOfDay(result) < now) result.setFullYear(result.getFullYear() + 1);
    return isValidCalendarDate(result, day, month, result.getFullYear()) ? startOfDay(result) : null;
  }

  for (const [pattern, weekday] of WEEKDAYS) {
    if (!pattern.test(normalized)) continue;
    const daysAhead = (weekday - now.getDay() + 7) % 7 || 7;
    base.setDate(base.getDate() + daysAhead);
    return base;
  }
  return null;
}

export function parseRussianTime(text: string): ParsedTime | null {
  const normalized = text.toLowerCase().replace(/ё/g, "е");
  const withMinutes = normalized.matchAll(/(?:^|\s)(?:в\s*)?(\d{1,2})\s*[:.]\s*(\d{2})(?=\s|[,.!?]|$)/gu);
  for (const candidate of withMinutes) {
    const hours = Number(candidate[1]);
    const minutes = Number(candidate[2]);
    if (hours <= 23 && minutes <= 59) return { hours, minutes, ambiguous: false };
  }
  const hourOnly = normalized.match(/(?:^|\s)в\s+(\d{1,2})(?=\s|[,.!?]|$)/u);
  if (!hourOnly) return null;
  let hours = Number(hourOnly[1]);
  if (hours > 23) return null;
  const ambiguous = hours >= 1 && hours <= 11;
  if (ambiguous) hours += 12;
  return { hours, minutes: 0, ambiguous };
}

export function combineDateAndTime(date: Date, time: ParsedTime): Date {
  const result = new Date(date);
  result.setHours(time.hours, time.minutes, 0, 0);
  return result;
}

export function parseRussianDateTime(text: string, now = new Date()): ParsedDateTime | null {
  const date = parseRussianDate(text, now);
  const time = parseRussianTime(text);
  if (!date || !time) return null;
  return { value: combineDateAndTime(date, time), ambiguousTime: time.ambiguous };
}

function isValidCalendarDate(value: Date, day: number, month: number, year: number): boolean {
  return value.getFullYear() === year && value.getMonth() === month && value.getDate() === day;
}
