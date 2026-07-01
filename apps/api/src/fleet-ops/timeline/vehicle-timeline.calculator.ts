import { VehicleTimelineResolver } from "./vehicle-timeline.resolver";
import type { TimelineDay, TimelineEvent, VehicleTimelineRawInput } from "./vehicle-timeline.types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class VehicleTimelineCalculator {
  private readonly resolver = new VehicleTimelineResolver();

  calculateTimeline(events: TimelineEvent[], input: Pick<VehicleTimelineRawInput, "from" | "to">): TimelineDay[] {
    const dateKeys = enumerateDateKeys(input.from, input.to);

    return dateKeys.map((date) => {
      const activeEvents = events.filter((event) => event.startDate <= date && event.endDate >= date);

      return this.resolver.resolveDay(date, activeEvents);
    });
  }
}

function enumerateDateKeys(from: Date, to: Date) {
  const start = startOfUtcDay(from).getTime();
  const end = startOfUtcDay(to).getTime();

  if (start > end) {
    return [];
  }

  const dates: string[] = [];
  for (let time = start; time <= end; time += MS_PER_DAY) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }

  return dates;
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
