import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";

/**
 * Compiles a schema once into a type guard for values that arrive untyped, such as returned
 * results, parsed output, and replayed session data. The schema is the single description of
 * the shape: its static type is what the guard narrows to.
 */
export function shapeGuard<T extends TSchema>(schema: T): (value: unknown) => value is Static<T> {
  const validator = Compile(schema);
  return (value: unknown): value is Static<T> => validator.Check(value);
}

/** Object options for shapes that own every key, so an unknown field means a different shape. */
export const CLOSED = { additionalProperties: false } as const;
