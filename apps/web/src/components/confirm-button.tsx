import { type ReactNode, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ConfirmButtonProps {
  /** The trigger, usually a `<Button>`. */
  children: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => unknown;
  destructive?: boolean;
  /** When set, the user has to type this text before confirming. */
  confirmText?: string;
  extra?: ReactNode;
}

/** Keyboard-accessible confirmation dialog in front of a destructive action. */
export function ConfirmButton({
  children,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = true,
  confirmText,
  extra,
}: ConfirmButtonProps) {
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const blocked = confirmText !== undefined && typed !== confirmText;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped('');
      }}
    >
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {extra}
        {confirmText !== undefined && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-text">
              Type <span className="font-mono font-semibold">{confirmText}</span> to confirm
            </Label>
            <Input
              id="confirm-text"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={blocked}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
