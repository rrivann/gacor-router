// OpenAI-compatible error envelope, so off-the-shelf clients (Cline, Roo,
// openai-python, curl) can parse failures instead of guessing.

export type ErrorType =
  | "invalid_request_error"
  | "not_implemented_error"
  | "no_available_account_error"
  | "internal_error";

export function errorResponse(
  status: number,
  type: ErrorType,
  message: string,
  code?: string
): Response {
  return Response.json(
    { error: { message, type, code: code ?? null, param: null } },
    { status }
  );
}
