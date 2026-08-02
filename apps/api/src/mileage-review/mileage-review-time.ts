import { BadRequestException } from "@nestjs/common";

const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function assertMileageReviewTimestamp(
  review: {
    baselineReading: { recordedAt: Date };
  },
  value: Date,
  asOf = new Date()
) {
  const latestAllowed = new Date(asOf.getTime() + CLOCK_SKEW_MS);
  if (
    value.getTime() < review.baselineReading.recordedAt.getTime() ||
    value.getTime() > latestAllowed.getTime()
  ) {
    throw new BadRequestException("Mileage reading time is outside the allowed review window.");
  }
}
