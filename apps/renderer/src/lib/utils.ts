import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** ShadCN-standard class merger: conditional classes + Tailwind dedupe. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
