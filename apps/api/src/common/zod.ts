import { ArgumentMetadata, Body, Injectable, PipeTransform, Query, applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { problem } from '@sil/hr-shared';
import { ProblemException, zodErrors } from './problem';

/** zod → JSON Schema (2020-12, which OpenAPI 3.1 uses as its schema dialect). */
export function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'output'): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

@Injectable()
export class ZodPipe implements PipeTransform {
  constructor(private readonly schema: z.ZodType) {}

  transform(value: unknown, _meta: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new ProblemException(422, 'validation_failed', 'The request is not valid', zodErrors(result.error));
    }
    return result.data;
  }
}

function attachMethodDecorator(target: object, key: string | symbol | undefined, decorator: MethodDecorator): void {
  if (!key) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor) decorator(target, key, descriptor);
}

/** Validated, typed request body, documented in OpenAPI from the same schema. */
export function ZBody(schema: z.ZodType): ParameterDecorator {
  return (target, key, index) => {
    Body(new ZodPipe(schema))(target, key, index);
    attachMethodDecorator(target, key, ApiBody({ schema: jsonSchema(schema, 'input') as never }));
  };
}

/** Validated query string; each top-level property becomes a documented parameter. */
export function ZQuery(schema: z.ZodObject): ParameterDecorator {
  return (target, key, index) => {
    Query(new ZodPipe(schema))(target, key, index);
    const json = jsonSchema(schema, 'input') as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      attachMethodDecorator(
        target,
        key,
        ApiQuery({ name, required: json.required?.includes(name) ?? false, schema: prop as never, description: prop.description as string | undefined }),
      );
    }
  };
}

const problemSchema = jsonSchema(problem);

/** Documents a success response (and the standard problem responses). */
export function ZResponse(schema: z.ZodType | null, status = 200, description = 'OK'): MethodDecorator {
  const decorators: MethodDecorator[] = [
    schema ? ApiResponse({ status, description, schema: jsonSchema(schema) as never }) : ApiResponse({ status, description }),
    ApiResponse({ status: 'default' as never, description: 'Problem details (RFC 9457)', content: { 'application/problem+json': { schema: problemSchema as never } } }),
  ];
  return applyDecorators(...decorators);
}
