export type DialogVariant = "default" | "destructive" | "warning" | "info";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
  /** Prefer focus on the safe (cancel) action for destructive dialogs. Default true when destructive. */
  preferCancelFocus?: boolean;
}

export interface AlertOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: Exclude<DialogVariant, "destructive">;
}

export interface PromptOptions {
  title: string;
  description?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Return an error message to block submit, or null/undefined to accept. */
  validate?: (value: string) => string | null | undefined;
}

export type DialogRequest =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "alert"; options: AlertOptions; resolve: (v: void) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (v: string | null) => void };
