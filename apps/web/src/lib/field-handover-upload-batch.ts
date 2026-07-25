export type FieldEvidenceUploadBatchStatus =
  | "IDLE"
  | "REFRESH_FAILED"
  | "REFRESHING"
  | "RETRY_PENDING"
  | "UPLOADING";
export type FieldEvidenceUploadInterruptionReason = "FAILURE" | "UNMOUNT" | "USER_CANCEL";
export type FieldEvidenceUploadRefreshTarget = "IDLE" | "RETRY_PENDING";

export interface FieldEvidenceUploadBatch<TFile> {
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
  getInterruptionReason: (error: unknown) => FieldEvidenceUploadInterruptionReason;
  onStateChange?: (state: FieldEvidenceUploadBatchState<TFile>) => void;
  onUploadInterrupted?: (error: unknown, reason: FieldEvidenceUploadInterruptionReason) => void;
  refreshDetail: () => Promise<boolean>;
  uploadFile: (file: TFile, index: number) => Promise<void>;
}

export interface FieldEvidenceUploadRefreshDependencies<TFile> {
  onStateChange?: (state: FieldEvidenceUploadBatchState<TFile>) => void;
  refreshDetail: () => Promise<boolean>;
}

export function startFieldEvidenceUploadBatch<TFile>(
  itemViewId: string,
  files: readonly TFile[],
  allowsMultiple: boolean
): FieldEvidenceUploadBatchState<TFile> {
  const selectedFiles = allowsMultiple ? [...files] : files.slice(0, 1);
  if (selectedFiles.length === 0) {
    return idleFieldEvidenceUploadBatch();
  }

  return {
    batch: { files: selectedFiles, itemViewId },
    fileIndex: 0,
    status: "UPLOADING"
  };
}

export function advanceFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>
): FieldEvidenceUploadBatchState<TFile> {
  if (state.status !== "UPLOADING" || !state.batch) {
    return state;
  }

  return {
    ...state,
    fileIndex: Math.min(state.fileIndex + 1, state.batch.files.length - 1)
  };
}

export function interruptFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  reason: FieldEvidenceUploadInterruptionReason
): FieldEvidenceUploadInterruption<TFile> {
  if (reason === "UNMOUNT") {
    return {
      shouldReloadDetail: false,
      shouldShowUserFeedback: false,
      state: idleFieldEvidenceUploadBatch()
    };
  }

  if (state.status !== "UPLOADING" || !state.batch) {
    return {
      shouldReloadDetail: false,
      shouldShowUserFeedback: false,
      state
    };
  }

  const remainingBatch = {
    files: state.batch.files.slice(state.fileIndex),
    itemViewId: state.batch.itemViewId
  };
  if (state.fileIndex === 0) {
    return {
      shouldReloadDetail: false,
      shouldShowUserFeedback: true,
      state: {
        batch: remainingBatch,
        fileIndex: 0,
        status: "RETRY_PENDING"
      }
    };
  }

  return {
    shouldReloadDetail: true,
    shouldShowUserFeedback: true,
    state: {
      batch: remainingBatch,
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
  if (!canEdit || state.status !== "RETRY_PENDING" || !state.batch) {
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
      await dependencies.uploadFile(file, index);
    } catch (error) {
      const reason = dependencies.getInterruptionReason(error);
      const interrupted = interruptFieldEvidenceUploadBatch(currentState, reason);
      currentState = publishState(interrupted.state, dependencies.onStateChange);
      if (interrupted.shouldShowUserFeedback) {
        dependencies.onUploadInterrupted?.(error, reason);
      }
      if (!interrupted.shouldReloadDetail) {
        return currentState;
      }
      return synchronizeFieldEvidenceUploadState(currentState, dependencies);
    }

    if (index < files.length - 1) {
      currentState = publishState(
        advanceFieldEvidenceUploadBatch(currentState),
        dependencies.onStateChange
      );
    }
  }

  currentState = publishState({
    batch: null,
    fileIndex: 0,
    refreshTarget: "IDLE",
    status: "REFRESHING"
  }, dependencies.onStateChange);
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
  return state.status === "IDLE";
}

export function canRetryFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  canEdit: boolean
) {
  return canEdit && state.status === "RETRY_PENDING" && Boolean(state.batch?.files.length);
}

async function synchronizeFieldEvidenceUploadState<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  dependencies: FieldEvidenceUploadRefreshDependencies<TFile>
) {
  let refreshed: boolean;
  try {
    refreshed = await dependencies.refreshDetail();
  } catch {
    refreshed = false;
  }

  const nextState = resolveFieldEvidenceUploadRefresh(state, refreshed);
  return publishState(nextState, dependencies.onStateChange);
}

function resolveFieldEvidenceUploadRefresh<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  refreshed: boolean
): FieldEvidenceUploadBatchState<TFile> {
  if (state.status !== "REFRESHING" || !state.refreshTarget) {
    return state;
  }
  if (!refreshed) {
    return { ...state, status: "REFRESH_FAILED" };
  }
  if (state.refreshTarget === "RETRY_PENDING" && state.batch) {
    return {
      batch: state.batch,
      fileIndex: 0,
      status: "RETRY_PENDING"
    };
  }
  return idleFieldEvidenceUploadBatch();
}

function publishState<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>,
  onStateChange?: (state: FieldEvidenceUploadBatchState<TFile>) => void
) {
  onStateChange?.(state);
  return state;
}

function idleFieldEvidenceUploadBatch<TFile>(): FieldEvidenceUploadBatchState<TFile> {
  return { batch: null, fileIndex: 0, status: "IDLE" };
}
