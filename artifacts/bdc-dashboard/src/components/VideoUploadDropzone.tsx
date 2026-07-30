import { useState, useRef, useEffect, useCallback } from 'react';
import { Video, Upload, X, Lock, Zap, Sparkles, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const LS_VIDEO_UNLOCK = 'bdc_video_unlocked';

function fmtFileSize(bytes: number): string {
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

interface Props {
  isPro: boolean;
  videoFile: File | null;
  onFileChange: (file: File | null) => void;
  /** Compact = no card shell — renders inline (for use inside other cards) */
  compact?: boolean;
}

export default function VideoUploadDropzone({ isPro, videoFile, onFileChange, compact = false }: Props) {
  const [isDragOver, setIsDragOver]         = useState(false);
  const [showModal, setShowModal]           = useState(false);
  const [pendingFile, setPendingFile]       = useState<File | null>(null);
  const [videoUnlocked, setVideoUnlocked]   = useState(false);
  const [verifying, setVerifying]           = useState(false);
  const [unlocking, setUnlocking]           = useState(false);
  const [unlockError, setUnlockError]       = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const canUpload = isPro || videoUnlocked;

  // ── On mount: restore unlock from localStorage or verify post-Stripe redirect ──
  useEffect(() => {
    const stored = localStorage.getItem(LS_VIDEO_UNLOCK);
    if (stored) { setVideoUnlocked(true); return; }

    const params = new URLSearchParams(window.location.search);
    const sessionId   = params.get('session_id');
    const unlockParam = params.get('video_unlocked');
    if (!sessionId || unlockParam !== '1') return;

    setVerifying(true);
    fetch(`/api/v1/billing/verify-video-session?session_id=${encodeURIComponent(sessionId)}`)
      .then(r => r.json())
      .then(d => {
        if (d.paid) {
          localStorage.setItem(LS_VIDEO_UNLOCK, sessionId);
          setVideoUnlocked(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        setVerifying(false);
        // Clean URL so back-button / reload don't re-verify
        const url = new URL(window.location.href);
        url.searchParams.delete('video_unlocked');
        url.searchParams.delete('session_id');
        window.history.replaceState({}, '', url.toString());
      });
  }, []);

  // ── File acceptance ───────────────────────────────────────────────────────────
  const acceptFile = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm)$/i.test(file.name);
    if (!isVideo) return;

    if (canUpload) {
      onFileChange(file);
    } else {
      setPendingFile(file);
      setShowModal(true);
    }
  }, [canUpload, onFileChange]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    acceptFile(e.dataTransfer.files);
  }, [acceptFile]);

  const openZone = useCallback(() => {
    if (canUpload) inputRef.current?.click();
    else setShowModal(true);
  }, [canUpload]);

  // ── $3 Stripe checkout ────────────────────────────────────────────────────────
  async function handleVideoUnlock() {
    setUnlocking(true);
    setUnlockError('');
    try {
      const base = `${window.location.origin}${window.location.pathname}`;
      const successUrl = `${base}?video_unlocked=1&session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl  = base;
      const res = await fetch('/api/v1/billing/create-video-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success_url: successUrl, cancel_url: cancelUrl }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setUnlockError(data.error || 'Could not start checkout. Please try again.');
      }
    } catch {
      setUnlockError('Network error. Please try again.');
    } finally {
      setUnlocking(false);
    }
  }

  function closeModal() {
    setShowModal(false);
    setPendingFile(null);
    setUnlockError('');
  }

  // ── Inner content (shared between compact and card layouts) ──────────────────
  const inner = (
    <>
      {verifying ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-3 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Verifying payment…
        </div>
      ) : videoFile ? (
        /* ── File attached ─────────────────────────────────────── */
        <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="w-8 h-8 rounded-md bg-primary/15 flex items-center justify-center flex-shrink-0">
            <Video className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{videoFile.name}</p>
            <p className="text-xs text-muted-foreground">{fmtFileSize(videoFile.size)} · attach manually when posting to Facebook</p>
          </div>
          <button
            onClick={() => onFileChange(null)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
            aria-label="Remove video"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        /* ── Dropzone ──────────────────────────────────────────── */
        <>
          <div
            onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onClick={openZone}
            className={`rounded-lg border-2 border-dashed transition-colors cursor-pointer py-6 flex flex-col items-center gap-2 select-none ${
              isDragOver
                ? 'border-primary bg-primary/5'
                : canUpload
                ? 'border-border hover:border-primary/50 hover:bg-muted/30'
                : 'border-border/60 bg-muted/20 hover:border-amber-500/40'
            }`}
          >
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${canUpload ? 'bg-primary/10' : 'bg-muted'}`}>
              {canUpload
                ? <Upload className="w-5 h-5 text-primary" />
                : <Lock className="w-5 h-5 text-muted-foreground" />}
            </div>
            <div className="text-center px-4">
              <p className="text-sm font-medium">
                {canUpload ? 'Drop a walkaround video here or click to browse' : 'Video uploads require Pro or a one-time purchase'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">MP4, MOV, AVI or MKV · Max 500 MB</p>
            </div>
            {!canUpload && (
              <p className="text-xs text-amber-600 dark:text-amber-400 font-semibold">
                Unlock for $3 per post · or upgrade to Pro for unlimited
              </p>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/avi,video/x-matroska,video/webm,.mp4,.mov,.avi,.mkv,.webm"
            className="hidden"
            onChange={e => acceptFile(e.target.files)}
          />
        </>
      )}

      {/* ── Payment modal ───────────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-sm space-y-5 rounded-2xl border border-slate-800/60 bg-slate-900/90 p-6 shadow-2xl backdrop-blur-md">

            {/* Close */}
            <button
              onClick={closeModal}
              className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>

            {/* Header */}
            <div className="flex flex-col items-center text-center space-y-2 pt-1">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Video className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-xl font-bold">Add a Video to This Listing</h2>
              {pendingFile && (
                <p className="text-xs text-muted-foreground bg-muted rounded-md px-3 py-1 max-w-full truncate">
                  {pendingFile.name}
                </p>
              )}
            </div>

            {unlockError && (
              <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2 text-center">
                {unlockError}
              </p>
            )}

            {/* Option A — $3 one-time */}
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-bold text-sm">Unlock Video for this Post</p>
                <span className="text-base font-bold text-primary">$3.00</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                One-time payment · Attach a walkaround video to this listing only
              </p>
              <Button className="w-full gap-2" onClick={handleVideoUnlock} disabled={unlocking}>
                {unlocking
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Starting checkout…</>
                  : 'Pay $3.00 — Unlock Video Upload'}
              </Button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground font-medium">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Option B — Pro */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-bold text-sm">Upgrade to Pro</p>
                <span className="text-sm font-bold">$75<span className="text-xs font-normal text-muted-foreground">/mo</span></span>
              </div>
              <ul className="space-y-1.5">
                {[
                  'Unlimited videos on every listing',
                  'Full inventory sync — auto-post your entire lot',
                  'AI posts, bulk scheduling & BDC analytics',
                ].map(f => (
                  <li key={f} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles className="w-3 h-3 text-primary flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <a
                href="/pricing"
                className="flex items-center justify-center gap-2 w-full h-10 rounded-lg border border-primary text-primary text-sm font-semibold hover:bg-primary/5 transition-colors"
              >
                <Zap className="w-4 h-4" />
                Upgrade to Pro ($75/mo)
              </a>
            </div>

          </div>
        </div>
      )}
    </>
  );

  // ── Card wrapper (non-compact) vs bare (compact) ──────────────────────────────
  if (compact) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Video className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Walkaround Video</span>
        </div>
        {inner}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-800/60 bg-slate-900/80 p-5 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold flex items-center gap-2">
          <Video className="w-4 h-4 text-muted-foreground" />
          Attach Walkaround Video
        </label>
        {!canUpload && (
          <Badge className="border border-amber-500/30 bg-amber-500/15 px-2 text-[10px] font-bold text-amber-300">
            Pro / Paid Feature
          </Badge>
        )}
      </div>
      {inner}
    </div>
  );
}
