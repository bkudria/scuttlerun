import { z } from 'zod';

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error && 'code' in err && typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

export function formatCliError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `[scuttlerun] Configuration error:\n${formatZodError(err)}`;
  }
  if (isErrnoException(err) && err.code === 'ENOENT') {
    return `[scuttlerun] Config file not found: ${err.path ?? '(unknown)'}`;
  }
  if (err instanceof Error) {
    return `[scuttlerun] Error: ${err.message}`;
  }
  return `[scuttlerun] Error: ${String(err)}`;
}
