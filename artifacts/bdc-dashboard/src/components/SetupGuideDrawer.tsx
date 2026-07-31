import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Check, Copy, ExternalLink, HelpCircle, X } from 'lucide-react';
import {
  expandGuideValue,
  resolveSetupGuide,
  type SetupGuide,
  type SetupGuideCopyBlock,
} from '@/lib/setupGuides';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Props = {
  guideId: string | null;
  open: boolean;
  onClose: () => void;
  /** Optional runtime overrides (e.g. live Meta feed URL). */
  copyOverrides?: SetupGuideCopyBlock[];
};

/** Renders guide body text with `UI labels` as badges and **bold** callouts. */
export function GuideRichText({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n\n+/);

  const renderInline = (chunk: string, keyPrefix: string): ReactNode[] => {
    const parts = chunk.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((part, i) => {
      const key = `${keyPrefix}-${i}`;
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <Badge
            key={key}
            variant="secondary"
            className="mx-0.5 align-middle px-1.5 py-0 text-[10px] font-semibold tracking-tight"
          >
            {part.slice(1, -1)}
          </Badge>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={key} className="font-semibold text-foreground">
            {part.slice(2, -2)}
          </strong>
        );
      }
      return <Fragment key={key}>{part}</Fragment>;
    });
  };

  return (
    <div className={cn('space-y-2', className)}>
      {paragraphs.map((para, pi) => {
        const lines = para.split('\n');
        const useCallout = paragraphs.length > 1;
        return (
          <p
            key={pi}
            className={cn(
              'text-xs leading-relaxed',
              useCallout
                ? 'rounded-md border border-border/80 bg-muted/50 px-2.5 py-2 text-foreground/90'
                : 'text-muted-foreground',
            )}
          >
            {lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(line, `${pi}-${li}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function CopyBlock({ block }: { block: SetupGuideCopyBlock }) {
  const [copied, setCopied] = useState(false);
  const value = expandGuideValue(block.value);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {block.label}
        </p>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors',
            copied
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              : 'bg-primary/10 text-primary hover:bg-primary/15',
          )}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <code className="block text-[11px] font-mono break-all text-foreground/90 select-all">
        {value}
      </code>
      {block.note && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">{block.note}</p>
      )}
    </div>
  );
}

export function SetupGuideDrawer({ guideId, open, onClose, copyOverrides }: Props) {
  const guide: SetupGuide | undefined = guideId ? resolveSetupGuide(guideId) : undefined;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !guide) return null;

  const blocks = copyOverrides?.length ? copyOverrides : guide.copyBlocks;

  return (
    <div
      className="fixed inset-0 z-[70] flex justify-end bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-guide-title"
    >
      <div className="h-full w-full max-w-lg bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border flex-shrink-0">
          <div className="w-9 h-9 rounded-full bg-sky-500/15 flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4 h-4 text-sky-600 dark:text-sky-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="setup-guide-title" className="text-base font-semibold leading-tight">
              {guide.title}
            </h2>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Step-by-step setup guide
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Close setup guide"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          <section className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Section Overview
            </p>
            <p className="text-sm text-foreground/85 leading-relaxed">{guide.overview}</p>
          </section>

          <section className="space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Exact Steps
            </p>
            <ol className="space-y-4">
              {guide.steps.map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold mt-0.5">
                    {i + 1}
                  </span>
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-sm font-medium leading-snug">{step.title}</p>
                    <GuideRichText text={step.body} />
                    {step.link && (
                      <a
                        href={step.link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline"
                      >
                        {step.link.label}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {blocks && blocks.length > 0 && (
            <section className="space-y-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Code / URL Copy Blocks
              </p>
              {blocks.map((b) => (
                <CopyBlock key={b.label + b.value} block={b} />
              ))}
            </section>
          )}

          <section className="space-y-2.5">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Common Errors &amp; Troubleshooting
            </p>
            <ul className="space-y-2">
              {guide.troubleshooting.map((item, i) => (
                <li
                  key={i}
                  className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-foreground/80 leading-relaxed"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="px-5 py-3 border-t border-border bg-muted/20 flex justify-end flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium bg-muted hover:bg-muted/80 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inline ❓ Setup Guide control — opens the drawer for a guide id. */
export function SetupGuideButton({
  guideId,
  className,
  label = 'Setup Guide',
  onOpen,
}: {
  guideId: string;
  className?: string;
  label?: string;
  onOpen?: (guideId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen(guideId);
        }}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline underline-offset-2',
          className,
        )}
      >
        <HelpCircle className="w-3.5 h-3.5" />
        {label}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline underline-offset-2',
          className,
        )}
      >
        <HelpCircle className="w-3.5 h-3.5" />
        {label}
      </button>
      <SetupGuideDrawer guideId={guideId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
