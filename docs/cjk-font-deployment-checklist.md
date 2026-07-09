# CJK Font Deployment Operator Checklist

## 1. Purpose

Chinese/CJK contract PDFs require a configured CJK font in the API runtime. The contract PDF renderer receives this font through `CONTRACT_PDF_CJK_FONT_PATH`; when rendered content contains CJK characters and no usable font path is configured, rendering fails fast instead of generating a potentially garbled PDF.

This checklist is operator-owned. It documents deployment choices, validation evidence, production gates, and rollback steps. It does not include font files, production environment values, legal template text, provider credentials, seal IDs, or provider calls.

## 2. Non-Negotiable Rules

- Do not commit font files to this repository.
- Do not share font files in ChatGPT/Codex output.
- Do not commit production environment values.
- Do not modify `Dockerfile.api` without explicit operator approval.
- Do not modify compose or env files without explicit operator approval.
- The exact font family, package, or file requires operator/legal license approval before use.
- The font path must be verified inside the running API container.
- Sandbox validation is required before production enablement.
- Codex must not call Fadada, trigger eSign, query production data, upload production files, or generate production contracts as part of font readiness work.

## 3. Deployment Options

### Option A: Install an approved CJK font package into the API image

Benefits:

- Most reproducible once approved.
- Same image behavior across local image validation, sandbox, and production.
- Lower risk of missing files at runtime.
- Rollback can use the previous image tag.

Risks:

- Requires `Dockerfile.api` changes and image rebuild.
- Increases image size.
- Requires legal/operator approval of the exact font package and license.
- Requires a verified stable in-container font path.

Approval requirements:

- Operator approval to modify the API image.
- Legal/operator approval of the exact font package and license.
- Image build, image scan if applicable, and sandbox validation approval.

Rollback:

- Revert to the previous approved API image tag.
- Keep `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED=false` until the replacement image passes validation.

When to use:

- Recommended production MVP after approval.

### Option B: Mount an approved CJK font file into the API container and set the env path

Benefits:

- No image rebuild required.
- Useful for sandbox or interim validation.
- Font file can remain outside the repository.

Risks:

- Mount and env configuration can drift across environments.
- Runtime failure risk is higher if the mount is missing, unreadable, or points to a different path.
- Production reproducibility depends on operator deployment discipline.

Approval requirements:

- Operator/legal approval of the exact font file and license.
- Operator approval of sandbox and production mount paths.
- Read-only mount and API container read validation.

Rollback:

- Remove or revert the mount/env setting through the operator deployment process.
- Disable `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED` if PDF generation has already been tested.

When to use:

- Sandbox/interim validation only unless operators explicitly accept the production operational risk.

### Option C: Use an internal approved base image or deployment layer containing fonts

Benefits:

- Can centralize font compliance and patch ownership.
- Useful if a platform team already maintains approved runtime images.
- Reduces per-service Dockerfile logic.

Risks:

- Font provenance and version may be less visible from this repository.
- Requires base-image governance and version pinning.
- Runtime path still must be verified in the API container.

Approval requirements:

- Platform/operator approval of the base image or deployment layer.
- Legal/operator approval that the included font is permitted for contract PDF generation.
- Evidence of the stable in-container font path.

Rollback:

- Revert to the previous approved base image or deployment layer.
- Disable PDF artifact generation if CJK rendering is affected.

When to use:

- Use when the platform team already owns an approved base image or font layer.

Do not treat any example font family, package, or path as approved unless operator/legal approval evidence exists.

## 4. Required Environment Variables

- `CONTRACT_PDF_CJK_FONT_PATH`: absolute path to the approved CJK font file inside the API container.
- `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED`: enables generated source PDF creation when set to `true`; keep disabled until font validation passes.
- `FADADA_ENABLED`: enables real Fadada transport paths; do not enable for font-only validation.
- `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED`: enables enterprise auto seal behavior; keep disabled until sandbox go/no-go gates pass.
- `ESIGN_PLATFORM_SEAL_KEYWORD`: approved platform seal keyword used by eSign positioning.
- `ESIGN_PLATFORM_SEAL_KEYX`: platform seal keyword offset intent.
- `ESIGN_PLATFORM_SEAL_KEYY`: platform seal keyword offset intent.

Safe sandbox order:

1. Configure `CONTRACT_PDF_CJK_FONT_PATH`.
2. Verify the path exists and is readable inside the API container.
3. Enable `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED=true` in sandbox only.
4. Generate a controlled sandbox PDF.
5. Visually review the PDF.
6. Test Fadada sandbox only after PDF source validation passes and Fadada docs have been checked for any provider behavior being exercised.
7. Test enterprise auto seal in sandbox only after generated source PDF and source hardening pass.
8. Move toward production only after the completed go/no-go process.

## 5. Container Validation Commands

Operators can run these inside the API container or through the approved container execution process. These are checklist examples, not commands for Codex to run during docs work.

```sh
printenv CONTRACT_PDF_CJK_FONT_PATH
test -f "$CONTRACT_PDF_CJK_FONT_PATH"
test -r "$CONTRACT_PDF_CJK_FONT_PATH"
node -e "const fs=require('fs'); const p=process.env.CONTRACT_PDF_CJK_FONT_PATH; if(!p) throw new Error('missing'); fs.accessSync(p, fs.constants.R_OK); console.log(p)"
```

Record the container ID/name, image tag, environment, configured font path, and command output in the sandbox validation record.

## 6. PDF Validation Checklist

- Chinese text is not garbled.
- PDF remains text/searchable where feasible.
- PDF is not image-only.
- File size is `<=20MB`.
- Generated source `objectKey` matches `contracts/{contractId}/generated/...`.
- Generated source path is not a signed archive path.
- Generated source path is not a sandbox/test fixture path.
- `服务提供方盖章` appears exactly once.
- `订阅方盖章/签字` appears exactly once.
- Platform seal keyword has right-side blank space.
- Source hardening preflight passes before any eSign/Fadada upload.
- Generated source PDF path and final signed PDF archive path remain distinct.

## 7. Interaction With Legal Template

The formal DOCX inspected for legal template activation already contains both signing anchors exactly once:

- `服务提供方盖章`
- `订阅方盖章/签字`

The current render model also injects signing anchors through the generated signing block. Directly importing legal body text that still contains these anchors may duplicate anchors in the final render model.

Template activation must choose one anchor placement strategy before enabling PDF generation:

1. Use anchors in the approved legal body and avoid a duplicate renderer-generated anchor block through a separately approved renderer/template strategy.
2. Remove the anchor strings from the legal body and let the renderer append the signing block.

Do not activate generated PDF artifact creation for a CJK legal template until final render-model anchor uniqueness is verified.

## 8. Production Enablement Gate

Production enablement requires all of the following:

- Approved font family/package/file.
- Font license approval recorded by operator/legal.
- Sandbox container path recorded.
- Production container path recorded.
- API container read check passed.
- Legal template approved.
- Appendix structure approved.
- Anchor placement strategy resolved.
- Final render model contains each required signing anchor exactly once.
- Generated PDF visual review passed.
- Generated PDF source hardening passed.
- Sandbox double-sign passed.
- Final signed PDF archived and reviewed.
- Rollback owner assigned.
- Production go/no-go approved.

This checklist does not make production ready by itself.

## 9. Rollback

If enterprise auto seal causes issues:

1. Disable `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED`.
2. If the generated PDF chain fails, disable `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED`.
3. Revert the image, mount, or env configuration through the approved operator process.
4. Restart or recreate the API only through the approved operator process.
5. Do not manually mark old failed tasks successful.
6. Do not backfill old contracts automatically.
7. After fixes, generate a new controlled order, contract, and signing task.

## 10. Evidence Record

Record sandbox evidence in `docs/esign-sandbox-validation-record.md`.

Evidence should include:

- Approved font source and license approval reference.
- Deployment option selected.
- API image tag or mount details.
- `CONTRACT_PDF_CJK_FONT_PATH` value used in sandbox.
- API container path/read validation output.
- Generated source PDF object key.
- PDF visual review evidence.
- Anchor uniqueness evidence.
- Source hardening preflight result.
- Final signed PDF archive evidence when eSign sandbox validation is performed.

Do not paste secrets, production env values, provider credentials, seal binaries, private download URLs, identity document numbers, font binaries, or full customer personal data into the evidence record.
