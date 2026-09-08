export type PreviewType = "image" | "pdf" | "text" | null;

export interface ClipItem {
  id: string;
  kind: "text" | "file";
  size: number;
  createdAt: number;
  expiresAt: number;
  text?: string;
  fileName?: string;
  mimeType?: string;
  previewType?: PreviewType;
}

export interface LibraryFile {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
  previewType: PreviewType;
}

export interface PreviewFile {
  scope: "items" | "library";
  id: string;
  fileName: string;
  mimeType?: string;
  size: number;
  previewType: PreviewType;
  revision?: number;
  expiresAt?: number;
}
