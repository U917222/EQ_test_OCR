export type UploadFile = {
  name: string;
  mimeType: string;
  base64: string;
};

export const D1_DIRECT_MAX_BYTES = 900 * 1024;
export const GAS_DRIVE_MAX_BYTES = 9 * 1024 * 1024;

export async function prepareUploadFile(file: File): Promise<UploadFile> {
  if (file.type === "application/pdf") {
    if (file.size > GAS_DRIVE_MAX_BYTES) {
      throw new Error("PDFは現在9MB以下のみ登録できます。より大きいPDFはR2有効化が必要です。");
    }
    return {
      name: file.name,
      mimeType: file.type,
      base64: await readFileAsBase64(file),
    };
  }

  if (!file.type.startsWith("image/")) {
    throw new Error("画像またはPDFを選択してください");
  }

  const compressed = await compressImage(file);
  return {
    name: compressed.name,
    mimeType: compressed.type,
    base64: await readFileAsBase64(compressed),
  };
}

export async function compressImage(file: File): Promise<File> {
  if (file.size <= D1_DIRECT_MAX_BYTES && file.type === "image/jpeg") return file;

  const image = await loadImage(file);
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像を処理できませんでした");
  context.drawImage(image, 0, 0, width, height);

  let quality = 0.82;
  let blob = await canvasToBlob(canvas, quality);
  while (blob.size > D1_DIRECT_MAX_BYTES && quality > 0.45) {
    quality -= 0.08;
    blob = await canvasToBlob(canvas, quality);
  }

  if (blob.size > D1_DIRECT_MAX_BYTES) {
    if (file.size <= GAS_DRIVE_MAX_BYTES) return file;
    throw new Error("画像は現在9MB以下のみ登録できます。より大きい画像はR2有効化が必要です。");
  }

  const name = file.name.replace(/\.[^.]+$/, "") || "scoresheet";
  return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
}

export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした"));
    };
    image.src = url;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("画像を圧縮できませんでした"));
      },
      "image/jpeg",
      quality,
    );
  });
}

export function readFileAsBase64(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
