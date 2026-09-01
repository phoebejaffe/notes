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

export function formatLogicalDay(dayKey: string) {
  const day = new Date(`${dayKey}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(day)
}
