export type ErrorCode = 'UNAUTHENTICATED'|'FORBIDDEN'|'NOT_FOUND'|'CONFLICT'|'VALIDATION'|'RATE_LIMITED'|'UPSTREAM_UNAVAILABLE';
export class AppError extends Error {constructor(public code:ErrorCode, public status:number, message:string){super(message);}}
