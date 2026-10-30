import { type FieldViolation, ValidationError } from '@gam/kernel';
import { StandardSchemaValidationPipe } from '@nestjs/common';

type Issue = {
  message: string;
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined;
};

/** Converts Standard Schema issues (Zod) into a ValidationError with field violations (-> 400 problem). */
export function issuesToValidationError(issues: readonly Issue[]): ValidationError {
  const violations: FieldViolation[] = issues.map((issue) => ({
    field:
      (issue.path ?? [])
        .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
        .join('.') || '(root)',
    description: issue.message,
  }));
  const first = violations[0];
  return new ValidationError(
    first ? `invalid ${first.field}: ${first.description}` : 'invalid request',
    violations,
  );
}

/** Global pipe: validates every `@Body/@Query/@Param({ schema })` with its Zod schema. */
export const validationPipe = new StandardSchemaValidationPipe({
  exceptionFactory: (issues) => issuesToValidationError(issues),
});
