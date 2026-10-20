import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Classes Tailwind combinées ; la dernière gagne en cas de conflit (`px-2` puis `px-4` → `px-4`). */
export function cn(...entrees: ClassValue[]) {
  return twMerge(clsx(entrees));
}
