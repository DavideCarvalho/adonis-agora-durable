import { Popover as PopoverPrimitive } from '@base-ui-components/react/popover';
import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * Base UI Popover for the header's click-to-expand chips (pods, partitions, the `+N` overflow).
 *
 * These were absolutely-positioned divs, which meant: no dismissal on an outside click, no Escape,
 * no focus return, and a `z-20` that only worked because nothing else in the header stacked above
 * it. The primitive portals the content out of the header's fixed-width slot and handles all four.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export interface PopoverContentProps
  extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Popup> {
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

/** Portal + Positioner + Popup collapsed into the one part a call site cares about. */
export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ className, side = 'bottom', align = 'end', sideOffset = 4, ...props }, ref) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="z-40"
      >
        <PopoverPrimitive.Popup
          ref={ref}
          className={cn(
            'rise w-72 overflow-hidden rounded-md border border-line bg-popover/95 text-zinc-300 shadow-xl backdrop-blur focus-visible:outline-none',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  ),
);
PopoverContent.displayName = 'PopoverContent';
