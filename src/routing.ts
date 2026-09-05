/**
 * Shared offline/online + model session. Chat owns persistence; the workflow
 * panel and executor consume the same object. No per-workflow routing blob.
 */
export interface Routing {
  offlineMode: boolean;
  model?: string;
  localModel?: string;
  cloudModel?: string;
}

export interface RoutingSession {
  get(): Routing;
  set(patch: Partial<Routing>): void;
  subscribe(listener: () => void): () => void;
}

export function createRoutingSession(initial?: Partial<Routing>): RoutingSession {
  let routing: Routing = {
    offlineMode: true,
    ...initial,
  };
  routing.model = routing.offlineMode ? routing.localModel : routing.cloudModel;
  const listeners = new Set<() => void>();

  const resolveModel = (next: Routing): Routing => {
    const model = next.offlineMode ? next.localModel : next.cloudModel;
    return { ...next, model };
  };

  return {
    get() {
      return { ...routing };
    },
    set(patch) {
      const next = resolveModel({ ...routing, ...patch });
      if (
        next.offlineMode === routing.offlineMode &&
        next.model === routing.model &&
        next.localModel === routing.localModel &&
        next.cloudModel === routing.cloudModel
      ) {
        return;
      }
      routing = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
