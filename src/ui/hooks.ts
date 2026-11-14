import { useEffect, useState } from "react";

/** Loads something once per key; `null` while loading. */
export function useLoaded<T>(key: string | undefined, load: () => Promise<T>): { value: T | null; failed: boolean } {
  const [state, setState] = useState<{ key?: string; value: T | null; failed: boolean }>({ value: null, failed: false });
  useEffect(() => {
    if (!key) return;
    let live = true;
    setState({ key, value: null, failed: false });
    load().then(
      (value) => live && setState({ key, value, failed: false }),
      () => live && setState({ key, value: null, failed: true }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? { value: state.value, failed: state.failed } : { value: null, failed: false };
}
