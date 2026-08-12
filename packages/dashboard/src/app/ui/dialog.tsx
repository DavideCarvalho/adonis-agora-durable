import { Dialog as DialogPrimitive } from '@base-ui-components/react/dialog';
import { XIcon } from '../icons';
import { Button } from './button';
import { cn } from './cn';

/**
 * Base UI Dialog — used uniformly with the rest of the primitive layer rather than reaching for the
 * platform's `<dialog>` for this one case. One primitive layer across the four Aviary consoles is
 * the point (see AVIARY-UI.md): a modal that is a `<dialog>` here and a Dialog part everywhere else
 * is a fork in how every console's overlays are written, styled and tested.
 *
 * The parts are re-exported for anything that needs the full composition; {@link Dialog} is the
 * shape this console actually uses (a titled panel with an optional footer).
 */
export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function Dialog({
  open,
  onOpenChange,
  title,
  subtitle,
  footer,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <DialogPrimitive.Popup
          className={cn(
            'rise fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel-2 text-foreground shadow-2xl focus-visible:outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-[15px] font-semibold tracking-tight text-zinc-50">
                {title}
              </DialogPrimitive.Title>
              {subtitle && (
                <DialogPrimitive.Description className="mono mt-1 text-[11px] text-zinc-500">
                  {subtitle}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogClose
              render={
                <Button variant="quiet" size="icon" aria-label="Close">
                  <XIcon />
                </Button>
              }
            />
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogRoot>
  );
}
