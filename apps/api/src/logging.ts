export const LOG_REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'api_key',
  'admin_api_key', 'dkim_private_key', 'secret',
] as const;
