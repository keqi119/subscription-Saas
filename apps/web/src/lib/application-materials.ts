export interface CompatibleMaterialFile {
  fileName?: string | null;
  fileRecordId?: string | null;
  id?: string | null;
  originalName?: string | null;
  previewUrl?: string | null;
  sizeBytes?: number | null;
  url?: string | null;
}

export interface CompatibleApplicationMaterial {
  file?: CompatibleMaterialFile | null;
  fileName?: string | null;
  files?: CompatibleMaterialFile[];
}

export function getMaterialFiles(material: CompatibleApplicationMaterial): CompatibleMaterialFile[] {
  if (material.files?.length) {
    return material.files;
  }

  if (material.file) {
    return [material.file];
  }

  if (material.fileName) {
    return [{ fileName: material.fileName }];
  }

  return [];
}

export function getMaterialFileName(file: CompatibleMaterialFile) {
  return file.originalName || file.fileName || "未命名文件";
}

export function renderMaterialFileNames(material: CompatibleApplicationMaterial) {
  const files = getMaterialFiles(material);

  if (!files.length) {
    return "暂无文件";
  }

  return files.map(getMaterialFileName).join("、");
}
