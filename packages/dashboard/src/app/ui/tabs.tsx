import { Tabs as TabsPrimitive } from '@base-ui-components/react/tabs';
import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * Base UI Tabs, styled as this console's segmented control. Worth the primitive: the hand-rolled
 * version was three plain buttons with no roles and no keyboard model — this gets arrow-key
 * navigation, `role="tablist"`, and the tab↔panel wiring for free.
 *
 * Base UI names the parts `Tab`/`Panel` where shadcn-on-Radix said `Trigger`/`Content`; the exports
 * keep Base UI's names so the call sites read like the library's own documentation.
 */
export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'flex items-center gap-0.5 rounded border border-line bg-zinc-900/60 p-0.5',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTab = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Tab>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Tab>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Tab
    ref={ref}
    className={cn(
      'mono cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[active]:bg-zinc-700 data-[active]:text-zinc-100',
      className,
    )}
    {...props}
  />
));
TabsTab.displayName = 'TabsTab';

export const TabsPanel = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Panel>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Panel>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Panel
    ref={ref}
    className={cn('focus-visible:outline-none', className)}
    {...props}
  />
));
TabsPanel.displayName = 'TabsPanel';
