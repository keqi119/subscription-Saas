"use client";

import {
  CameraOutlined,
  FolderOpenOutlined,
  UploadOutlined
} from "@ant-design/icons";
import { Alert, Button, Drawer, Flex, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

import {
  buildFieldEvidenceUploadInputContracts,
  clearFieldVideoSelectionPending,
  completeFieldEvidenceUploadSelection,
  consumeInterruptedFieldVideoSelection,
  type FieldEvidenceMediaType,
  type FieldEvidenceUploadEnvironment,
  type FieldEvidenceUploadInputContract,
  getFieldEvidenceUploadGuidance,
  markFieldVideoSelectionPending,
  routeFieldEvidenceUploadPrimaryAction
} from "../lib/field-handover-upload";

export interface EvidenceUploadControlsProps {
  allowedMediaTypes: FieldEvidenceMediaType[];
  disabled: boolean;
  environment: FieldEvidenceUploadEnvironment;
  evidenceType?: string;
  id: string;
  label?: string;
  multiple: boolean;
  onFiles: (files: File[]) => void;
  variant?: "primary" | "secondary";
}

export function EvidenceUploadControls({
  allowedMediaTypes,
  disabled,
  environment,
  evidenceType,
  id,
  label = "资料上传",
  multiple,
  onFiles,
  variant = "primary"
}: EvidenceUploadControlsProps) {
  const contracts = buildFieldEvidenceUploadInputContracts(
    allowedMediaTypes,
    multiple,
    environment,
    evidenceType
  );
  const inputRefs = useRef<
    Partial<Record<FieldEvidenceUploadInputContract["key"], HTMLInputElement>>
  >({});
  const [chooserOpen, setChooserOpen] = useState(false);
  const [selectionWarning, setSelectionWarning] = useState<string | null>(null);
  const guidance = getFieldEvidenceUploadGuidance(allowedMediaTypes, evidenceType);
  const tracksMobileVideoSelection =
    environment === "MOBILE" && evidenceType === "WALKAROUND_VIDEO";

  useEffect(() => {
    if (!tracksMobileVideoSelection || typeof window === "undefined") {
      return;
    }
    try {
      if (consumeInterruptedFieldVideoSelection(window.sessionStorage, id)) {
        setSelectionWarning(interruptedVideoSelectionMessage());
      }
    } catch {
      // The picker remains usable when sessionStorage is unavailable.
    }
  }, [id, tracksMobileVideoSelection]);

  function selectContract(contract: FieldEvidenceUploadInputContract) {
    setSelectionWarning(null);
    if (tracksMobileVideoSelection && typeof window !== "undefined") {
      try {
        markFieldVideoSelectionPending(window.sessionStorage, id);
      } catch {
        // The picker remains usable when sessionStorage is unavailable.
      }
    }
    inputRefs.current[contract.key]?.click();
  }

  return (
    <div style={{ marginTop: 10 }}>
      {contracts.map((contract) => (
        <input
          accept={contract.accept}
          capture={contract.capture}
          disabled={disabled}
          id={`${id}-${contract.key}`}
          key={contract.key}
          multiple={contract.multiple}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (tracksMobileVideoSelection && typeof window !== "undefined") {
              try {
                clearFieldVideoSelectionPending(window.sessionStorage, id);
              } catch {
                // The selected file can still upload when sessionStorage is unavailable.
              }
            }
            if (files.length === 0) {
              setChooserOpen(false);
              if (tracksMobileVideoSelection) {
                setSelectionWarning(interruptedVideoSelectionMessage());
              }
              return;
            }
            setSelectionWarning(null);
            completeFieldEvidenceUploadSelection(files, {
              closeMobileChooser: () => setChooserOpen(false),
              onFiles
            });
          }}
          ref={(node) => {
            inputRefs.current[contract.key] = node ?? undefined;
          }}
          style={{ display: "none" }}
          type="file"
        />
      ))}
      {guidance ? (
        <Typography.Paragraph
          style={{ color: "#607086", fontSize: 12, marginBottom: 8 }}
        >
          {guidance}
        </Typography.Paragraph>
      ) : null}
      {selectionWarning ? (
        <Alert
          message={selectionWarning}
          showIcon
          style={{ marginBottom: 8 }}
          type="warning"
        />
      ) : null}
      <Button
        block
        disabled={disabled}
        icon={<UploadOutlined />}
        onClick={() =>
          routeFieldEvidenceUploadPrimaryAction(environment, contracts, {
            openMobileChooser: () => setChooserOpen(true),
            selectContract
          })
        }
        style={{ minHeight: 44 }}
        type={variant === "primary" ? "primary" : "default"}
      >
        {label}
      </Button>
      {environment === "MOBILE" ? (
        <Drawer
          closable
          onClose={() => setChooserOpen(false)}
          open={chooserOpen}
          placement="bottom"
          title="资料上传"
        >
          <Flex gap={8} vertical>
            {contracts.map((contract) => (
              <Button
                block
                disabled={disabled}
                icon={
                  contract.key === "photo-capture" ? (
                    <CameraOutlined />
                  ) : contract.key === "library" ? (
                    <FolderOpenOutlined />
                  ) : (
                    <UploadOutlined />
                  )
                }
                key={contract.key}
                onClick={() => selectContract(contract)}
                size="large"
              >
                {contract.label}
              </Button>
            ))}
          </Flex>
        </Drawer>
      ) : null}
    </div>
  );
}

function interruptedVideoSelectionMessage() {
  return "系统未能读取所选视频。超过 200 MB 请先保存到手机“文件”，再使用“从文件选择”上传。";
}
