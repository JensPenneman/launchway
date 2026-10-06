import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { errorMessage } from './request';

interface ApiMutationOptions<TVariables, TData> {
  /** Query families to refresh after success (the change feed refreshes them too, later). */
  invalidate?: readonly QueryKey[];
  /** Toast shown after success. */
  success?: string | ((data: TData, variables: TVariables) => string);
  onSuccess?: (data: TData, variables: TVariables) => void;
}

/** `useMutation` with the UI conventions: error toasts, success toasts, query invalidation. */
export function useApiMutation<TVariables = void, TData = unknown>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: ApiMutationOptions<TVariables, TData> = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (data, variables) => {
      const { success, invalidate = [], onSuccess } = options;
      if (success) toast.success(typeof success === 'string' ? success : success(data, variables));
      onSuccess?.(data, variables);
      await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
}
