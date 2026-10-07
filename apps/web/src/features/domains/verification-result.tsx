import type { DomainVerification } from '@launchway/contracts';
import { CheckCircle2, XCircle } from 'lucide-react';
import { CopyButton } from '@/components/copy-button';
import { formatDateTime } from '@/lib/format';

/** Outcome of the DNS preflight, including the records to create for unmanaged domains. */
export function VerificationResult({ result }: { result: DomainVerification }) {
  const observed = [
    ...result.observed.cname.map((value) => `CNAME ${value}`),
    ...result.observed.a.map((value) => `A ${value}`),
    ...result.observed.aaaa.map((value) => `AAAA ${value}`),
  ];
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="verification-result">
      <div className="flex items-start gap-2">
        {result.ok ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden="true" />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <div>
          <p className="font-medium">
            {result.ok ? 'DNS points at Launchway' : 'DNS is not ready'}
          </p>
          <p className="text-muted-foreground">{result.message}</p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-3 font-mono text-xs">
        <dt className="font-sans text-muted-foreground">Expected</dt>
        <dd>
          {result.expected
            ? `${result.expected.type} ${result.expected.value}`
            : 'unknown (no public IPv4 or anchor yet)'}
        </dd>
        <dt className="font-sans text-muted-foreground">Observed</dt>
        <dd>{observed.length > 0 ? observed.join(', ') : 'nothing'}</dd>
        <dt className="font-sans text-muted-foreground">Checked</dt>
        <dd>{formatDateTime(result.checkedAt)}</dd>
      </dl>
      {result.requiredRecords.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="font-medium">Create these records at your DNS provider</p>
          {result.requiredRecords.map((record) => {
            const text = `${record.name} ${record.type} ${record.content}`;
            return (
              <div
                key={text}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <code className="truncate text-xs">{text}</code>
                <CopyButton value={record.content} label="Copy value" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
