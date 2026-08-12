import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's class combiner: `clsx` for conditionals, `tailwind-merge` so a caller's `className`
 *  actually WINS over a variant's default instead of depending on stylesheet order. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
