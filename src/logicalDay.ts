export function logicalDayKey(date: Date, rolloverHour = 4) {
  const day = new Date(date)
  if (day.getHours() < rolloverHour) day.setDate(day.getDate() - 1)
  const year = day.getFullYear()
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const dateOfMonth = String(day.getDate()).padStart(2, '0')
  return `${year}-${month}-${dateOfMonth}`
}

export function shiftLogicalDay(dayKey: string, amount: number) {
  const day = new Date(`${dayKey}T12:00:00`)
  day.setDate(day.getDate() + amount)
  return logicalDayKey(day, 0)
}

import type { DateFormat } from './preferences'

export function formatLogicalDay(dayKey: string, dateFormat: DateFormat = 'long') {
  const day = new Date(`${dayKey}T12:00:00`)
  const formats: Record<DateFormat, Intl.DateTimeFormatOptions> = {
    long: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
    'long-short': { weekday: 'long', month: 'short', day: 'numeric' },
    'weekday-month': { weekday: 'short', month: 'long', day: 'numeric' },
    short: { month: 'short', day: 'numeric', year: 'numeric' },
    'month-day': { month: 'long', day: 'numeric' },
    iso: { year: 'numeric', month: '2-digit', day: '2-digit' },
    numeric: { year: 'numeric', month: 'numeric', day: 'numeric' },
  }
  if (dateFormat === 'iso') return dayKey
  return new Intl.DateTimeFormat(undefined, formats[dateFormat]).format(day)
}
