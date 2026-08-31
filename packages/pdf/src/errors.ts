import type { ErrorCode } from '@scansign/shared';

/** An error carrying a code the console can display verbatim to the operator. */
export class PdfPipelineError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfPipelineError';
    this.code = code;
  }
}
