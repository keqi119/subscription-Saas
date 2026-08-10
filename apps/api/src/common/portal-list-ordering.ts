export interface PortalListSortKey {
  createdAt: Date;
  deadlineAt: Date | null;
  id: string;
  priority: number;
  updatedAt: Date;
}

export interface PortalBucketCount<TBucket extends string> {
  bucket: TBucket;
  count: number;
}

export interface PortalBucketSlice<TBucket extends string> {
  bucket: TBucket;
  skip: number;
  take: number;
}

export function comparePortalListSortKeys(
  left: PortalListSortKey,
  right: PortalListSortKey
) {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.deadlineAt && right.deadlineAt) {
    const deadlineDiff = left.deadlineAt.getTime() - right.deadlineAt.getTime();
    if (deadlineDiff !== 0) return deadlineDiff;
  } else if (left.deadlineAt || right.deadlineAt) {
    return left.deadlineAt ? -1 : 1;
  }
  const updatedDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updatedDiff !== 0) return updatedDiff;
  const createdDiff = right.createdAt.getTime() - left.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  return left.id.localeCompare(right.id);
}

export function sortByPortalListOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => PortalListSortKey
) {
  return [...items].sort((left, right) =>
    comparePortalListSortKeys(keyOf(left), keyOf(right))
  );
}

export function planPortalBucketPage<TBucket extends string>(
  buckets: readonly PortalBucketCount<TBucket>[],
  skip: number,
  take: number
): PortalBucketSlice<TBucket>[] {
  if (skip < 0 || take <= 0) return [];
  const slices: PortalBucketSlice<TBucket>[] = [];
  let remainingSkip = skip;
  let remainingTake = take;
  for (const { bucket, count } of buckets) {
    if (remainingTake === 0) break;
    if (remainingSkip >= count) {
      remainingSkip -= count;
      continue;
    }
    const bucketTake = Math.min(count - remainingSkip, remainingTake);
    slices.push({ bucket, skip: remainingSkip, take: bucketTake });
    remainingSkip = 0;
    remainingTake -= bucketTake;
  }
  return slices;
}
