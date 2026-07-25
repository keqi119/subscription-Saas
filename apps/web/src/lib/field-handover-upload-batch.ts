export type FieldEvidenceUploadBatchStatus = "IDLE" | "RETRY_PENDING" | "UPLOADING";
export type FieldEvidenceUploadInterruptionReason = "FAILURE" | "UNMOUNT" | "USER_CANCEL";

export interface FieldEvidenceUploadBatch<TFile> {
  files: TFile[];
  itemViewId: string;
}

export interface FieldEvidenceUploadBatchState<TFile> {
  batch: FieldEvidenceUploadBatch<TFile> | null;
  fileIndex: number;
  status: FieldEvidenceUploadBatchStatus;
}

export interface FieldEvidenceUploadInterruption<TFile> {
  shouldReloadDetail: boolean;
  shouldShowUserFeedback: boolean;
  state: FieldEvidenceUploadBatchState<TFile>;
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

  return {
    shouldReloadDetail: true,
    shouldShowUserFeedback: true,
    state: {
      batch: {
        files: state.batch.files.slice(state.fileIndex),
        itemViewId: state.batch.itemViewId
      },
      fileIndex: 0,
      status: "RETRY_PENDING"
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

export function completeFieldEvidenceUploadBatch<TFile>(
  state: FieldEvidenceUploadBatchState<TFile>
): FieldEvidenceUploadBatchState<TFile> {
  if (state.status === "IDLE") {
    return state;
  }
  return idleFieldEvidenceUploadBatch();
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

function idleFieldEvidenceUploadBatch<TFile>(): FieldEvidenceUploadBatchState<TFile> {
  return { batch: null, fileIndex: 0, status: "IDLE" };
}
