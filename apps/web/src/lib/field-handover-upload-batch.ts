export type FieldEvidenceUploadBatchStatus = "IDLE" | "REFRESH_FAILED" | "REFRESHING" | "UPLOADING";
export type FieldEvidenceUploadInterruptionReason = "FAILURE" | "UNMOUNT" | "USER_CANCEL";
export type FieldEvidenceUploadRefreshTarget = "IDLE" | "RECOVERABLE";

export interface FieldEvidenceUploadSnapshot {
  count: number;
  ids: string[];
}

export type FieldEvidenceUploadOperation =
  | { type: "APPEND" }
  | { replaceEvidenceFileId: string; type: "REPLACE" };

export interface FieldEvidenceUploadBatch<TFile> {
  baseline: FieldEvidenceUploadSnapshot;
  files: TFile[];
  itemViewId: string;
  operation: FieldEvidenceUploadOperation;
}

export interface FieldEvidenceUploadRecovery<TFile> {
  baseline: FieldEvidenceUploadSnapshot;
  errorMessage: string;
  files: TFile[];
  itemViewId: string;
  operation: FieldEvidenceUploadOperation;
}

export interface FieldEvidenceUploadBatchState<TFile> {
  batch: FieldEvidenceUploadBatch<TFile> | null;
  fileIndex: number;
  recoveries: Record<string, FieldEvidenceUploadRecovery<TFile>>;
  refreshTarget?: FieldEvidenceUploadRefreshTarget;
  status: FieldEvidenceUploadBatchStatus;
}

export interface FieldEvidenceUploadInterruption<TFile> {
  shouldReloadDetail: boolean;
  shouldShowUserFeedback: boolean;
  state: FieldEvidenceUploadBatchState<TFile>;
}

export interface FieldEvidenceUploadBatchDependencies<TFile> {
  getFailureMessage: (error: unknown) => string;
  getInterruptionReason: (error: unknown) => FieldEvidenceUploadInterruptionReason;
  onStateChange?: (state: FieldEvidenceUploadBatchState<TFile>) => void;
  onUploadInterrupted?: (error: unknown, reason: FieldEvidenceUploadInterruptionReason) => void;
  refreshDetail: () => Promise<FieldEvidenceUploadSnapshot | null>;
  uploadFile: (file: TFile, index: number) => Promise<FieldEvidenceUploadSnapshot>;
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
  baseline: FieldEvidenceUploadSnapshot = EMPTY_UPLOAD_SNAPSHOT,
  operation: FieldEvidenceUploadOperation = { type: "APPEND" }
): FieldEvidenceUploadBatchState<TFile> {
  const selectedFiles = allowsMultiple ? [...files] : files.slice(0, 1);
  if (selectedFiles.length === 0) {
    return idleFieldEvidenceUploadBatch();
  }

  return {
    batch: {
      baseline: normalizeSnapshot(baseline),
      files: selectedFiles,
      itemViewId,
      operation
    },
    fileIndex: 0,
    recoveries: {},
    status: "UPLOADING"
  };
}

export function advanceFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  baseline: FieldEvidenceUploadSnapshot = state.batch?.baseline ?? EMPTY_UPLOAD_SNAPSHOT
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
  reason: FieldEvidenceUploadInterruptionReason,
  errorMessage: string
): FieldEvidenceUploadInterruption<TFile> {
  if (state.status !== "UPLOADING" || !state.batch) {
    return {
      shouldReloadDetail: false,
      shouldShowUserFeedback: false,
      state
    };
  }

  const remainingFiles = state.batch.files.slice(state.fileIndex);
  const recovery: FieldEvidenceUploadRecovery<TFile> = {
    baseline: state.batch.baseline,
    errorMessage,
    files: remainingFiles,
    itemViewId: state.batch.itemViewId,
    operation: state.batch.operation
  };

  return {
    shouldReloadDetail: true,
    shouldShowUserFeedback: reason !== "UNMOUNT",
    state: {
      batch: {
        baseline: state.batch.baseline,
        files: remainingFiles,
        itemViewId: state.batch.itemViewId,
        operation: state.batch.operation
      },
      fileIndex: 0,
      recoveries: {
        ...state.recoveries,
        [state.batch.itemViewId]: recovery
      },
      refreshTarget: "RECOVERABLE",
      status: "REFRESHING"
    }
  };
}

export function retryFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  itemViewId: string,
  canEdit: boolean,
  operation?: FieldEvidenceUploadOperation
): FieldEvidenceUploadBatchState<TFile> {
  const recovery = state.recoveries[itemViewId];
  if (!canEdit || state.status !== "IDLE" || !recovery) {
    return state;
  }

  const remainingRecoveries = { ...state.recoveries };
  delete remainingRecoveries[itemViewId];
  return {
    batch: {
      baseline: recovery.baseline,
      files: recovery.files,
      itemViewId: recovery.itemViewId,
      operation: operation ?? recovery.operation
    },
    fileIndex: 0,
    recoveries: remainingRecoveries,
    status: "UPLOADING"
  };
}

export function abandonFieldEvidenceUploadRecovery<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  itemViewId: string
): FieldEvidenceUploadBatchState<TFile> {
  if (state.status !== "IDLE" || !state.recoveries[itemViewId]) {
    return state;
  }

  const remainingRecoveries = { ...state.recoveries };
  delete remainingRecoveries[itemViewId];
  return {
    ...state,
    recoveries: remainingRecoveries
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
        reason,
        dependencies.getFailureMessage(error)
      );
      currentState = publishState(interrupted.state, dependencies.onStateChange);
      if (interrupted.shouldShowUserFeedback) {
        dependencies.onUploadInterrupted?.(error, reason);
      }
      return synchronizeFieldEvidenceUploadState(currentState, dependencies);
    }

    if (index < files.length - 1) {
      currentState = publishState(
        advanceFieldEvidenceUploadBatch(currentState, currentState.batch?.baseline),
        dependencies.onStateChange
      );
    }
  }

  currentState = publishState(
    {
      batch: null,
      fileIndex: 0,
      recoveries: currentState.recoveries,
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
  return synchronizeFieldEvidenceUploadState(refreshingState, dependencies);
}

export function canSubmitWithFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>
) {
  return state.status === "IDLE" && !hasFieldEvidenceUploadRecoveries(state);
}

export function canRetryFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  itemViewId: string,
  canEdit: boolean
) {
  return canEdit && state.status === "IDLE" && Boolean(state.recoveries[itemViewId]?.files.length);
}

export function canStartFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  itemViewId: string
) {
  return state.status === "IDLE" && !state.recoveries[itemViewId];
}

export function hasFieldEvidenceUploadRecoveries<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>
) {
  return Object.keys(state.recoveries).length > 0;
}

export function canMutateFieldEvidenceWithUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>
) {
  return state.status === "IDLE";
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
    return idleFieldEvidenceUploadBatch(state.recoveries);
  }
  if (!state.batch) {
    return idleFieldEvidenceUploadBatch(state.recoveries);
  }

  const authoritative = normalizeSnapshot(refreshed);
  const currentFileCommitted = operationCommitted(
    state.batch.baseline,
    authoritative,
    state.batch.operation
  );
  const remainingFiles = currentFileCommitted ? state.batch.files.slice(1) : state.batch.files;
  if (remainingFiles.length === 0) {
    const remainingRecoveries = { ...state.recoveries };
    delete remainingRecoveries[state.batch.itemViewId];
    return idleFieldEvidenceUploadBatch(remainingRecoveries);
  }

  const recovery = state.recoveries[state.batch.itemViewId];
  const recoveries = {
    ...state.recoveries,
    [state.batch.itemViewId]: {
      ...(recovery ?? {
        errorMessage: "",
        itemViewId: state.batch.itemViewId
      }),
      baseline: authoritative,
      files: remainingFiles,
      operation: state.batch.operation
    }
  };
  return idleFieldEvidenceUploadBatch(recoveries);
}

function operationCommitted(
  before: FieldEvidenceUploadSnapshot,
  after: FieldEvidenceUploadSnapshot,
  operation: FieldEvidenceUploadOperation
) {
  const beforeIds = new Set(before.ids);
  const afterIds = new Set(after.ids);
  const addedIds = [...afterIds].filter((id) => !beforeIds.has(id));

  if (operation.type === "APPEND") {
    return addedIds.length > 0 && after.count >= before.count + 1;
  }

  return (
    after.count > 0 &&
    after.count >= before.count &&
    beforeIds.has(operation.replaceEvidenceFileId) &&
    !afterIds.has(operation.replaceEvidenceFileId) &&
    addedIds.length > 0
  );
}

function normalizeSnapshot(snapshot: FieldEvidenceUploadSnapshot): FieldEvidenceUploadSnapshot {
  const ids = [
    ...new Set(snapshot.ids.filter((id): id is string => typeof id === "string" && Boolean(id)))
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

function idleFieldEvidenceUploadBatch<TFile>(
  recoveries: Record<string, FieldEvidenceUploadRecovery<TFile>> = {}
): FieldEvidenceUploadBatchState<TFile> {
  return {
    batch: null,
    fileIndex: 0,
    recoveries,
    status: "IDLE"
  };
}
