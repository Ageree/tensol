export type DeepReadonly<T> = T extends ReadonlyArray<infer U>
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (value === null || typeof value !== 'object') {
    return value as DeepReadonly<T>;
  }
  if (Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as DeepReadonly<T>;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return Object.freeze(value) as DeepReadonly<T>;
};
