import type { UserRole } from '@slipway/contracts';
import { useQuery } from '@tanstack/react-query';
import { meQuery } from '@/api/auth';
import { can } from '@/lib/roles';

/** The signed-in principal (loaded by the `_app` route before any page renders). */
export function useMe() {
  return useQuery(meQuery).data;
}

/** Whether the signed-in principal has at least `minimum`; viewers get read-only pages. */
export function useCan(minimum: UserRole): boolean {
  return can(useMe(), minimum);
}
