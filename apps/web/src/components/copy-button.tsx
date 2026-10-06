import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error('Copying is not allowed here; select the text instead.');
    }
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void copy()}
      aria-label={label}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** Monospace block with a copy button, for tokens and snippets shown once. */
export function CopyBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
        {value}
      </pre>
    </div>
  );
}
