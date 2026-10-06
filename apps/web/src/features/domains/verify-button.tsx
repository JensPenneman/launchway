import type { DomainVerification } from '@slipway/contracts';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { verifyDomain } from '@/api/domains';
import { keys } from '@/api/keys';
import { useApiMutation } from '@/api/mutation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { VerificationResult } from './verification-result';

/** Runs the DNS preflight for one domain and shows the result in a dialog. */
export function VerifyButton({
  domainId,
  hostname,
  compact = false,
}: {
  domainId: string;
  hostname: string;
  /** Icon-only button, for dense tables. */
  compact?: boolean;
}) {
  const [result, setResult] = useState<DomainVerification | null>(null);
  const verify = useApiMutation(() => verifyDomain(domainId), {
    invalidate: [keys.domains, keys.edge],
    onSuccess: setResult,
  });
  return (
    <>
      <Button
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'icon-sm' : 'sm'}
        onClick={() => verify.mutate()}
        disabled={verify.isPending}
        aria-label={`Verify ${hostname}`}
        title="Run the DNS check"
      >
        {verify.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
        {!compact && 'Verify'}
      </Button>
      <Dialog open={result !== null} onOpenChange={(open) => !open && setResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono">{hostname}</DialogTitle>
            <DialogDescription>DNS preflight result</DialogDescription>
          </DialogHeader>
          {result && <VerificationResult result={result} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
