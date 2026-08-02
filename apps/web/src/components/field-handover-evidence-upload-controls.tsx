"use client";

import {
  CameraOutlined,
  FolderOpenOutlined,
  UploadOutlined
} from "@ant-design/icons";
import { Button, Drawer, Flex, Typography } from "antd";
import { useRef, useState } from "react";

import {
  buildFieldEvidenceUploadInputContracts,
  completeFieldEvidenceUploadSelection,
  type FieldEvidenceMediaType,
  type FieldEvidenceUploadEnvironment,
  type FieldEvidenceUploadInputContract,
  getFieldEvidenceUploadGuidance,
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
    environment
  );
  const inputRefs = useRef<
    Partial<Record<FieldEvidenceUploadInputContract["key"], HTMLInputElement>>
  >({});
  const [chooserOpen, setChooserOpen] = useState(false);
  const guidance = getFieldEvidenceUploadGuidance(allowedMediaTypes, evidenceType);

  function selectContract(contract: FieldEvidenceUploadInputContract) {
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
