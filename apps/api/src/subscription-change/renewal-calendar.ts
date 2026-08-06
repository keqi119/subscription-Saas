export type RenewalReminderSchedule = Record<"D30" | "D14" | "D3", Date>;

export interface RenewalSchedule {
  completionDeadlineAt: Date;
  considerationStartAt: Date;
  reminders: RenewalReminderSchedule;
}

export function renewalSchedule(endDate: Date): RenewalSchedule {
  return {
    completionDeadlineAt: atShanghaiHour(addUtcDays(endDate, 1), 0),
    considerationStartAt: atShanghaiHour(addUtcDays(endDate, -30), 9),
    reminders: {
      D30: atShanghaiHour(addUtcDays(endDate, -30), 9),
      D14: atShanghaiHour(addUtcDays(endDate, -14), 9),
      D3: atShanghaiHour(addUtcDays(endDate, -3), 9)
    }
  };
}

export function shanghaiBusinessDate(value: Date) {
  const shanghai = new Date(value.getTime() + 8 * 3_600_000);
  return new Date(
    Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate())
  );
}

export function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function atShanghaiHour(date: Date, hour: number) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour) -
      8 * 3_600_000
  );
}
