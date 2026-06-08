import { API_BASE_URL, ApiError } from "./api";

export async function downloadCsv(path: string, defaultFilename: string) {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: "include"
    });
  } catch {
    throw new ApiError("无法连接 API 服务，请确认后端 3001 端口已启动。", 0);
  }

  if (!response.ok) {
    throw new ApiError(await readDownloadErrorMessage(response), response.status);
  }

  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("Content-Disposition")) ?? defaultFilename;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function readDownloadErrorMessage(response: Response) {
  const contentType = response.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) {
        return body.message.join(", ");
      }
      if (body.message) {
        return body.message;
      }
    } catch {
      return "导出失败，请稍后重试";
    }
  }

  const text = await response.text();
  return text.trim() || "导出失败，请稍后重试";
}

function filenameFromDisposition(disposition: string | null) {
  if (!disposition) {
    return null;
  }

  const encodedMatch = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encodedMatch?.[1]) {
    return decodeURIComponent(encodedMatch[1].trim());
  }

  const quotedMatch = /filename="([^"]+)"/i.exec(disposition);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const plainMatch = /filename=([^;]+)/i.exec(disposition);
  return plainMatch?.[1]?.trim() ?? null;
}
