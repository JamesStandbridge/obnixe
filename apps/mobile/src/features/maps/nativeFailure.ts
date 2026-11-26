import { useCallback } from "react";
import { useSnackbar } from "@/ui/SnackbarHost";

type NativeModuleError = Error & { readonly code: string };

/** Promise rejections of native modules carry a string code; anything else is a bug and must surface. */
function isNativeModuleError(error: unknown): error is NativeModuleError {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

export function useNativeFailure(): (task: Promise<void>, message: string) => void {
  const notify = useSnackbar();
  return useCallback(
    (task: Promise<void>, message: string): void => {
      void task.catch((error: unknown) => {
        if (!isNativeModuleError(error)) throw error;
        notify({ text: message });
      });
    },
    [notify],
  );
}
