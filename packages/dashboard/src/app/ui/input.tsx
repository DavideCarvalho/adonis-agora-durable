import { forwardRef } from 'react';
import { XIcon } from '../icons';
import { Button } from './button';
import { cn } from './cn';

/** The bare field. The border lives on {@link InputField} so a glyph and a clear button can sit
 *  inside the same box, which is how every filter in this console is drawn. */
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'mono w-full bg-transparent py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export interface InputFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Leading glyph (`#`, `⛃`) — decorative, so it is hidden from assistive tech. */
  glyph?: React.ReactNode;
  /** Renders a clear button while the field is non-empty. */
  onClear?: () => void;
  clearLabel?: string;
  containerClassName?: string;
}

/** A bordered filter row: glyph · input · clear. Focus-within moves the ring to the whole box, which
 *  is the only way a bordered composite reads as one control. */
export const InputField = forwardRef<HTMLInputElement, InputFieldProps>(
  ({ glyph, onClear, clearLabel = 'clear', containerClassName, value, ...props }, ref) => (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md border border-line px-2 transition-colors focus-within:border-zinc-600',
        containerClassName,
      )}
    >
      {glyph !== undefined && (
        <span className="shrink-0 text-zinc-600" aria-hidden>
          {glyph}
        </span>
      )}
      <Input ref={ref} value={value} {...props} />
      {onClear && value ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          title={clearLabel}
          aria-label={clearLabel}
          className="h-4 w-4"
        >
          <XIcon width={12} height={12} />
        </Button>
      ) : null}
    </div>
  ),
);
InputField.displayName = 'InputField';
