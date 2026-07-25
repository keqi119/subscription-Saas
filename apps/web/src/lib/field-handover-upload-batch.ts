export type FieldEvidenceUploadBatchStatus =
  | "IDLE"
  | "REFRESH_FAILED"
  | "REFRESHING"
  | "RETRY_PENDING"
  | "UPLOADING";
export type FieldEvidenceUploadInterruptionReason =
  | "FAILURE"
  | "UNMOUNT"
  | "USER_CANCEL";
export type FieldEvidenceUploadRefreshTarget = "IDLE" | "RETRY_PENDING";

export interface FieldEvidenceUploadSnapshot {
  count: number;
  ids: string[];
}

export interface FieldEvidenceUploadBatch<TFile> {
  baseline: FieldEvidenceUploadSnapshot;
  files: TFile[];
  itemViewId: string;
}

export interface FieldEvidenceUploadBatchState<TFile> {
  batch: FieldEvidenceUploadBatch<TFile> | null;
  fileIndex: number;
  refreshTarget?: FieldEvidenceUploadRefreshTarget;
  status: FieldEvidenceUploadBatchStatus;
}

export interface FieldEvidenceUploadInterruption<TFile> {
  shouldReloadDetail: boolean;
  shouldShowUserFeedback: boolean;
  state: FieldEvidenceUploadBatchState<TFile>;
}

export interface FieldEvidenceUploadBatchDependencies<TFile> {
  getInterruptionReason: (
    error: unknown
  ) => FieldEvidenceUploadInterruptionReason;
  onStateChange?: (state: FieldEvidenceUploadBatchState<TFile>) => void;
  onUploadInterrupted?: (
    error: unknown,
    reason: FieldEvidenceUploadInterruptionReason
  ) => void;
  refreshDetail: () => Promise<FieldEvidenceUploadSnapshot | null>;
  uploadFile: (
    file: TFile,
    index: number
  ) => Promise<FieldEvidenceUploadSnapshot>;
}

export interface FieldEvidenceUploadRefreshDependencies<TFile> {
  onStateChange?: (state: FieldEvidenceUploadBatchState<TFile>) => void;
  refreshDetail: () => Promise<FieldEvidenceUploadSnapshot | null>;
}

const EMPTY_UPLOAD_SNAPSHOT: FieldEvidenceUploadSnapshot = {
  count: 0,
  ids: []
};

export function startFieldEvidenceUploadBatch<TFile>(
  itemViewId: string,
  files: readonly TFile[],
  allowsMultiple: boolean,
  baseline: FieldEvidenceUploadSnapshot = EMPTY_UPLOAD_SNAPSHOT
): FieldEvidenceUploadBatchState<TFile> {
  const selectedFiles = allowsMultiple ? [...files] : files.slice(0, 1);
  if (selectedFiles.length === 0) {
    return idleFieldEvidenceUploadBatch();
  }

  return {
    batch: {
      baseline: normalizeSnapshot(baseline),
      files: selectedFiles,
      itemViewId
    },
    fileIndex: 0,
    status: "UPLOADING"
  };
}

export function advanceFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  baseline: FieldEvidenceUploadSnapshot = state.batch?.baseline ??
    EMPTY_UPLOAD_SNAPSHOT
): FieldEvidenceUploadBatchState<TFile> {
  if (state.status !== "UPLOADING" || !state.batch) {
    return state;
  }

  return {
    ...state,
    batch: {
      ...state.batch,
      baseline: normalizeSnapshot(baseline)
    },
    fileIndex: Math.min(state.fileIndex + 1, state.batch.files.length - 1)
  };
}

export function interruptFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  reason: FieldEvidenceUploadInterruptionReason
): FieldEvidenceUploadInterruption<TFile> {
  if (state.status !== "UPLOADING" || !state.batch) {
    return {
      shouldReloadDetail: false,
      shouldShowUserFeedback: false,
      state
    };
  }

  return {
    shouldReloadDetail: true,
    shouldShowUserFeedback: reason !== "UNMOUNT",
    state: {
      batch: {
        baseline: state.batch.baseline,
        files: state.batch.files.slice(state.fileIndex),
        itemViewId: state.batch.itemViewId
      },
      fileIndex: 0,
      refreshTarget: "RETRY_PENDING",
      status: "REFRESHING"
    }
  };
}

export function retryFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  canEdit: boolean
): FieldEvidenceUploadBatchState<TFile> {
  if (
    !canEdit ||
    state.status !== "RETRY_PENDING" ||
    !state.batch
  ) {
    return state;
  }

  return {
    batch: state.batch,
    fileIndex: 0,
    status: "UPLOADING"
  };
}

export async function runFieldEvidenceUploadBatch<TFile>(
  initialState: FieldEvidenceUploadBatchState<TFile>,
  dependencies: FieldEvidenceUploadBatchDependencies<TFile>
): Promise<FieldEvidenceUploadBatchState<TFile>> {
  if (initialState.status !== "UPLOADING" || !initialState.batch) {
    return initialState;
  }

  let currentState = initialState;
  const files = initialState.batch.files;
  for (const [index, file] of files.entries()) {
    if (index < initialState.fileIndex) {
      continue;
    }
    try {
      const uploadedSnapshot = await dependencies.uploadFile(file, index);
      if (currentState.batch) {
        currentState = {
          ...currentState,
          batch: {
            ...currentState.batch,
            baseline: normalizeSnapshot(uploadedSnapshot)
          }
        };
      }
    } catch (error) {
      const reason = dependencies.getInterruptionReason(error);
      const interrupted = interruptFieldEvidenceUploadBatch(
        currentState,
        reason
      );
      currentState = publishState(
        interrupted.state,
        dependencies.onStateChange
      );
      if (interrupted.shouldShowUserFeedback) {
        dependencies.onUploadInterrupted?.(error, reason);
      }
      return synchronizeFieldEvidenceUploadState(currentState, dependencies);
    }

    if (index < files.length - 1) {
      currentState = publishState(
        advanceFieldEvidenceUploadBatch(
          currentState,
          currentState.batch?.baseline
        ),
        dependencies.onStateChange
      );
    }
  }

  currentState = publishState(
    {
      batch: null,
      fileIndex: 0,
      refreshTarget: "IDLE",
      status: "REFRESHING"
    },
    dependencies.onStateChange
  );
  return synchronizeFieldEvidenceUploadState(currentState, dependencies);
}

export async function retryFieldEvidenceUploadRefresh<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  dependencies: FieldEvidenceUploadRefreshDependencies<TFile>
): Promise<FieldEvidenceUploadBatchState<TFile>> {
  if (state.status !== "REFRESH_FAILED" || !state.refreshTarget) {
    return state;
  }

  const refreshingState = publishState(
    { ...state, status: "REFRESHING" },
    dependencies.onStateChange
  );
  return synchronizeFieldEvidenceUploadState(
    refreshingState,
    dependencies
  );
}

export function canSubmitWithFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>
) {
  return state.status === "IDLE";
}

export function canRetryFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  canEdit: boolean
) {
  return (
    canEdit &&
    state.status === "RETRY_PENDING" &&
    Boolean(state.batch?.files.length)
  );
}

export function cancelFieldEvidenceUploadRequest(
  controller: AbortController | null,
  setReason: (reason: "USER_CANCEL") => void
) {
  if (!controller || controller.signal.aborted) {
    return false;
  }
  setReason("USER_CANCEL");
  controller.abort();
  return true;
}

async function synchronizeFieldEvidenceUploadState<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  dependencies: FieldEvidenceUploadRefreshDependencies<TFile>
) {
  let refreshed: FieldEvidenceUploadSnapshot | null;
  try {
    refreshed = await dependencies.refreshDetail();
  } catch {
    refreshed = null;
  }

  const nextState = resolveFieldEvidenceUploadRefresh(state, refreshed);
  return publishState(nextState, dependencies.onStateChange);
}

function resolveFieldEvidenceUploadRefresh<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  refreshed: FieldEvidenceUploadSnapshot | null
): FieldEvidenceUploadBatchState<TFile> {
  if (state.status !== "REFRESHING" || !state.refreshTarget) {
    return state;
  }
  if (!refreshed) {
    return { ...state, status: "REFRESH_FAILED" };
  }
  if (state.refreshTarget === "IDLE") {
    return idleFieldEvidenceUploadBatch();
  }
  if (!state.batch) {
    return idleFieldEvidenceUploadBatch();
  }

  const authoritative = normalizeSnapshot(refreshed);
  const currentFileCommitted = snapshotsDiffer(
    state.batch.baseline,
    authoritative
  );
  const remainingFiles = currentFileCommitted
    ? state.batch.files.slice(1)
    : state.batch.files;
  if (remainingFiles.length === 0) {
    return idleFieldEvidenceUploadBatch();
  }

  return {
    batch: {
      baseline: authoritative,
      files: remainingFiles,
      itemViewId: state.batch.itemViewId
    },
    fileIndex: 0,
    status: "RETRY_PENDING"
  };
}

function snapshotsDiffer(
  before: FieldEvidenceUploadSnapshot,
  after: FieldEvidenceUploadSnapshot
) {
  if (before.count !== after.count) {
    return true;
  }
  const beforeIds = [...new Set(before.ids)].sort();
  const afterIds = [...new Set(after.ids)].sort();
  return (
    beforeIds.length !== afterIds.length ||
    beforeIds.some((id, index) => id !== afterIds[index])
  );
}

function normalizeSnapshot(
  snapshot: FieldEvidenceUploadSnapshot
): FieldEvidenceUploadSnapshot {
  const ids = [
    ...new Set(
      snapshot.ids.filter(
        (id): id is string => typeof id === "string" && Boolean(id)
      )
    )
  ];
  const count = Number.isFinite(snapshot.count)
    ? Math.max(0, Math.floor(snapshot.count))
    : ids.length;
  return { count, ids };
}

function publishState<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  onStateChange?: (state: FieldEvidenceUploadBatchState<TFile>) => void
) {
  onStateChange?.(state);
  return state;
}

function idleFieldEvidenceUploadBatch<
  TFile
>(): FieldEvidenceUploadBatchState<TFile> {
  return { batch: null, fileIndex: 0, status: "IDLE" };
}
