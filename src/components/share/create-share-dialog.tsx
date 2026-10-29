"use client";

import { useRef, useState } from "react";
import { Check, Copy, FileText, Loader2, Lock, Mail, ShieldOff, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CreateShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId?: string | null;
  onCreated?: (shareId: string, shareUrl: string) => void;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

type GateType = "none" | "email" | "otp";

const GATE_OPTIONS: { value: GateType; label: string; description: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "none", label: "No gate", description: "Anyone with the link can view", Icon: ShieldOff },
  { value: "email", label: "Email capture", description: "Viewer must enter their email", Icon: Mail },
  { value: "otp", label: "Email OTP", description: "Viewer gets a one-time code", Icon: Lock },
];

export function CreateShareDialog({ open, onOpenChange, contactId, onCreated }: CreateShareDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [gateType, setGateType] = useState<GateType>("none");
  const [submitting, setSubmitting] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    if (!picked) return;
    if (!picked.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Only PDF files are supported. Please convert PPTX to PDF first.");
      return;
    }
    if (picked.size > MAX_FILE_BYTES) {
      toast.error("File is too large. Maximum size is 25 MB.");
      return;
    }
    setFile(picked);
    if (!title) setTitle(picked.name.replace(/\.pdf$/i, ""));
  }

  async function handleCreate() {
    if (!file) {
      toast.error("Choose a PDF file to share.");
      return;
    }
    if (!title.trim()) {
      toast.error("Enter a title for the share.");
      return;
    }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", title.trim());
      form.append("gateType", gateType);
      if (contactId) form.append("contactId", contactId);

      const res = await fetch("/api/share", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data?.error ?? "Could not create the share link.");
        return;
      }

      setShareUrl(data.shareUrl);
      onCreated?.(data.id, data.shareUrl);
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyUrl() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      const el = document.createElement("textarea");
      el.value = shareUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose(next: boolean) {
    if (!next) {
      setFile(null);
      setTitle("");
      setGateType("none");
      setShareUrl(null);
      setCopied(false);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">Share a document</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Upload a PDF to create a trackable share link.
          </DialogDescription>
        </DialogHeader>

        {shareUrl ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Your share link is ready. Anyone with this link can view the document.
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareUrl}
                className="bg-muted border-border text-foreground text-xs h-8 font-mono"
              />
              <Button size="sm" variant="outline" onClick={copyUrl} className="shrink-0">
                {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* File picker */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">PDF file</Label>
              <div
                className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/50 px-4 py-3 cursor-pointer hover:bg-muted transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {file ? (
                  <>
                    <FileText className="size-5 text-primary shrink-0" />
                    <span className="text-sm text-foreground truncate flex-1">{file.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {(file.size / (1024 * 1024)).toFixed(1)} MB
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="size-5 text-muted-foreground shrink-0" />
                    <span className="text-sm text-muted-foreground">Click to choose a PDF (max 25 MB)</span>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            {/* Title */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Document title"
                className="bg-muted border-border text-foreground h-8 text-sm placeholder:text-muted-foreground"
              />
            </div>

            {/* Gate type */}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">Access</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {GATE_OPTIONS.map(({ value, label, description, Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setGateType(value)}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-center transition-colors ${
                      gateType === value
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border bg-muted/50 text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <Icon className={`size-4 ${gateType === value ? "text-primary" : ""}`} />
                    <span className="text-[11px] font-medium leading-tight">{label}</span>
                    <span className="text-[10px] leading-tight opacity-70">{description}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)} disabled={submitting}>
            {shareUrl ? "Close" : "Cancel"}
          </Button>
          {!shareUrl && (
            <Button
              onClick={handleCreate}
              disabled={!file || !title.trim() || submitting}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create share link"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
