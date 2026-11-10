import { ReactNode } from 'react';

/** Isolate Latin financial values when they appear inside RTL text. */
export function LtrValue({ children }: { children: ReactNode }) {
  return <bdi dir="ltr">{children}</bdi>;
}

/** Isolate an LTR value when it must be interpolated into a translated text string. */
export function isolateLtrText(value: string): string {
  return `\u2066${value}\u2069`;
}
