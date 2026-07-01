import { TimelineState, type TimelineConflict, type TimelineDay, type TimelineEvent } from "./vehicle-timeline.types";

const TIMELINE_STATE_PRIORITY: Record<TimelineState, number> = {
  [TimelineState.SERVICE_BLOCKED]: 100,
  [TimelineState.MAINTENANCE]: 90,
  [TimelineState.LEASED]: 80,
  [TimelineState.RESERVED]: 70,
  [TimelineState.AVAILABLE]: 60,
  [TimelineState.UNKNOWN]: 0
};

const STALE_DATA_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class VehicleTimelineResolver {
  resolveDay(date: string, activeEvents: TimelineEvent[]): TimelineDay {
    const sortedEvents = sortEventsForResolution(activeEvents);
    const winner = sortedEvents[0];

    if (!winner) {
      return {
        confidence: 20,
        conflicts: [],
        date,
        sourceEvents: [],
        state: TimelineState.UNKNOWN,
        warnings: ["No timeline event covers this day."]
      };
    }

    const conflicts = sortedEvents
      .filter((event) => event.state !== winner.state)
      .map((event) => conflictFor(winner, event));
    const warnings = uniqueStrings(sortedEvents.flatMap((event) => event.warnings));
    const confidence = calculateDayConfidence(date, winner, sortedEvents, conflicts);

    return {
      confidence,
      conflicts,
      date,
      sourceEvents: sortedEvents.map((event) => event.eventId).sort(),
      state: winner.state,
      warnings
    };
  }
}

function sortEventsForResolution(events: TimelineEvent[]) {
  return [...events].sort((left, right) => {
    const priorityDelta = TIMELINE_STATE_PRIORITY[right.state] - TIMELINE_STATE_PRIORITY[left.state];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    if (right.baseConfidence !== left.baseConfidence) {
      return right.baseConfidence - left.baseConfidence;
    }

    return left.eventId.localeCompare(right.eventId);
  });
}

function conflictFor(winner: TimelineEvent, loser: TimelineEvent): TimelineConflict {
  return {
    loserEventId: loser.eventId,
    loserState: loser.state,
    reason: `${winner.eventId} overrides overlapping ${loser.eventId}.`,
    winnerEventId: winner.eventId,
    winnerState: winner.state
  };
}

function calculateDayConfidence(
  date: string,
  winner: TimelineEvent,
  activeEvents: TimelineEvent[],
  conflicts: TimelineConflict[]
) {
  let confidence = winner.baseConfidence;

  if (conflicts.length > 0) {
    confidence -= Math.min(30, conflicts.length * 10);
  }

  if (activeEvents.some((event) => event.missingStartTimestamp || event.missingEndTimestamp)) {
    confidence -= 10;
  }

  if (activeEvents.some((event) => isStaleForDay(event, date))) {
    confidence -= 15;
  }

  return Math.max(0, Math.min(100, Math.round(confidence)));
}

function isStaleForDay(event: TimelineEvent, date: string) {
  if (!event.timestamp) {
    return false;
  }

  const dayTime = Date.parse(`${date}T00:00:00.000Z`);
  const eventDayTime = Date.UTC(
    event.timestamp.getUTCFullYear(),
    event.timestamp.getUTCMonth(),
    event.timestamp.getUTCDate()
  );

  return Math.floor((dayTime - eventDayTime) / MS_PER_DAY) > STALE_DATA_DAYS;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
