import { Tooltip as TooltipPrimitive } from '@base-ui-components/react/tooltip';
import type { ReactElement } from 'react';
import { cn } from './cn';

/** Wraps the whole app once. The delay is short because these tooltips carry operational detail
 *  (which pods, which queues) an operator is scanning, not decorative hints. */
export function TooltipProvider({
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider delay={150} closeDelay={80} {...props}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

const POPUP_CLASS =
  'z-50 max-w-[280px] whitespace-pre-line rounded-md border border-line bg-popover/95 px-2 py-1 text-left text-[10px] leading-relaxed text-zinc-300 shadow-xl backdrop-blur';

/**
 * The console's tooltip, keeping the call-site API the hand-rolled one had (`label` + `suppressed`).
 *
 * `suppressed` exists because several of these chips ALSO open a click-popover; without it the hover
 * bubble stacks on top of the popover it just opened. Base UI expresses that directly as `disabled`.
 *
 * What the primitive buys over the previous 25-line version: portalled content (it can no longer be
 * clipped by the header's fixed-width slot), collision-aware placement instead of a hard-coded
 * `right-0 top-full`, `role="tooltip"` wired to the trigger, and dismissal on Escape.
 */
export function Tooltip({
  label,
  suppressed,
  side = 'bottom',
  align = 'end',
  children,
}: {
  label: string;
  suppressed?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** The trigger element — Base UI renders IT, rather than wrapping it in another box. */
  children: ReactElement;
}) {
  return (
    <TooltipRoot disabled={suppressed ?? false}>
      <TooltipTrigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={4} collisionPadding={8}>
          <TooltipPrimitive.Popup className={cn(POPUP_CLASS)}>{label}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipRoot>
  );
}
