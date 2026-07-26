"use client";

import {
  CameraOutlined,
  FolderOpenOutlined,
  UploadOutlined,
  VideoCameraOutlined
} from "@ant-design/icons";
import { Button, Drawer, Flex } from "antd";
import { useRef, useState } from "react";

import {
  buildFieldEvidenceUploadInputContracts,
  completeFieldEvidenceUploadSelection,
  type FieldEvidenceMediaType,
  type FieldEvidenceUploadEnvironment,
  type FieldEvidenceUploadInputContract,
  routeFieldEvidenceUploadPrimaryAction
} from "../lib/field-handover-upload";

export interface EvidenceUploadControlsProps {
  allowedMediaTypes: FieldEvidenceMediaType[];
  disabled: boolean;
  environment: FieldEvidenceUploadEnvironment;
  id: string;
  multiple: boolean;
  onFiles: (files: File[]) => void;
}

export function EvidenceUploadControls({
  allowedMediaTypes,
  disabled,
  environment,
  id,
  multiple,
  onFiles
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
        type="primary"
      >
        资料上传
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
                  ) : contract.key === "video-capture" ? (
                    <VideoCameraOutlined />
                  ) : contract.accept === "image/*" ? (
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
