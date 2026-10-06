import type { DnsZoneId } from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { zonesQuery } from '@/api/domains';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const AUTO_ZONE = '__auto__';
export const EXTERNAL_ZONE = '__external__';

/** Picks how a new domain's DNS is handled: matching zone, a specific managed zone, or external. */
export function ZoneSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  const zones = useQuery(zonesQuery);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO_ZONE}>Managed: matching zone (automatic)</SelectItem>
        {(zones.data?.items ?? []).map((zone) => (
          <SelectItem key={zone.id} value={zone.id}>
            Managed: {zone.name}
          </SelectItem>
        ))}
        <SelectItem value={EXTERNAL_ZONE}>External: I manage the DNS record myself</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** `zoneId` field of CreateDomainInput for a ZoneSelect value. */
export function zoneIdInput(value: string): { zoneId?: DnsZoneId | null } {
  if (value === AUTO_ZONE) return {};
  if (value === EXTERNAL_ZONE) return { zoneId: null };
  return { zoneId: value as DnsZoneId };
}
