import { queryOptions } from '@tanstack/react-query';
import { api } from './client';

export const livenessQuery = queryOptions({
  queryKey: ['health', 'live'],
  queryFn: async () => {
    const { data } = await api.GET('/api/health/live');
    if (!data) throw new Error('The API is not reachable');
    return data;
  },
  staleTime: 30_000,
});
