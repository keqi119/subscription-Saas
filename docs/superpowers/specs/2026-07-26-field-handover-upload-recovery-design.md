# Field Handover Upload Recovery Design

## Context

The staging field handover flow fails while uploading evidence because the API
image does not contain `ffmpeg` or `ffprobe`, although every photo and video is
processed before it is stored. A rejected upload then leaves the web upload
batch in a retry-only state that disables every evidence input. The same page
also replaces unsaved field facts after a damage declaration refresh and
always renders mobile capture controls on desktop browsers.

## Goals

- Package and verify the media binaries required by evidence processing.
- Keep unsaved field facts visible when the damage declaration changes.
- Present one primary evidence upload action with device-appropriate behavior.
- Let an operator recover from a failed upload without losing authoritative
  reconciliation or becoming trapped in the page.
- Keep final submission blocked while an unresolved failed batch exists.

## Non-Goals

- Moving evidence processing to an asynchronous queue.
- Changing evidence size limits, evidence requirements, or Stage 2 PDF rules.
- Persisting every field-fact keystroke automatically.
- Allowing concurrent evidence uploads.

## Server Design

The API runtime image installs the Debian `ffmpeg` package, which provides both
`ffmpeg` and `ffprobe`. The image build verifies that both binaries are
executable so a broken runtime image fails during CI instead of at the first
field upload.

Evidence processing remains fail-closed. Source and derivative temporary files
are cleaned after a processing error, and no evidence database row is written
until processing and storage have succeeded. Media processing failures are
translated to a safe, recognizable service error for the field client while
internal command details remain server-side.

## Field Facts Design

Changing either damage state updates the local draft immediately. Detail
refreshes triggered by that action preserve the current draft instead of
replacing it with the server snapshot. The damage declaration itself still
uses the existing server behavior. The complete draft is persisted by the
existing Save action or immediately before final submission.

## Device-Aware Upload Design

Every evidence item renders one primary button labelled `资料上传`.

- Desktop-like environments open the normal file chooser directly.
- Mobile-like environments open a secondary chooser.
- Photo evidence offers `现场拍摄` and `从相册选择`.
- Video evidence offers `现场录像` and `从相册选择`.
- Mixed evidence exposes capture choices for each allowed media type plus the
  library choice.

Device classification is isolated in a pure helper and uses browser capability
signals. Server rendering defaults to desktop-safe behavior and classification
is updated after hydration. Hidden file inputs continue to express media type,
capture mode, and multiple-file support.

## Upload Recovery State

Only an active upload request and authoritative reconciliation refresh retain
the global evidence mutation lock. When reconciliation proves that the failed
file was not committed, the batch enters a recoverable failure state:

- Other evidence items become uploadable again.
- Final field submission remains blocked.
- The failed item shows its file name and error.
- `重试原文件` retries the remaining queue.
- `重新选择` replaces the failed queue with newly selected files for that item.
- `放弃本次上传` discards the failed queue and returns to idle.

If the request outcome is uncertain and authoritative refresh fails, all
evidence mutation remains blocked until the operator reloads the state. This
prevents duplicate uploads or replacement ambiguity.

Starting a different evidence upload while a recoverable failure exists keeps
the failed batch unresolved and is not treated as permission to submit. The
page therefore tracks the failed batch separately from the one active upload.

## Verification

Tests cover:

- API runtime image declarations for `ffmpeg` and `ffprobe`.
- Safe media-processing error mapping and cleanup.
- Damage-state refreshes preserving the current field-facts draft.
- Desktop and mobile upload action contracts.
- Retry, replace-selection, abandon, and submission gating transitions.
- Existing authoritative upload reconciliation behavior.

The staging verification uses the reported work order and uploads a small JPEG,
then confirms evidence persistence, preview generation, editable recovery
controls, retained field facts, and desktop/mobile action behavior.
