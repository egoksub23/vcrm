export const SHARE_BUCKET = "share-files";

export type ShareStatus = "active" | "revoked";
export type ShareGateType = "none" | "email" | "otp";

export interface ShareLink {
  id: string;
  accountId: string;
  createdBy: string;
  contactId: string | null;
  title: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  status: ShareStatus;
  gateType: ShareGateType;
  downloadEnabled: boolean;
  expiresAt: string | null;
  firstOpenedAt: string | null;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShareView {
  id: string;
  shareId: string;
  viewerEmail: string | null;
  viewedAt: string;
  durationMs: number | null;
  pageDwells: number[] | null;
}

/** What the public viewer needs to render the page (no secrets). */
export interface SharePublicInfo {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  gateType: ShareGateType;
  downloadEnabled: boolean;
}
