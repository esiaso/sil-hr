import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './generated/api';

export type { paths, components } from './generated/api';

/**
 * Typed client for the SIL HR REST API, generated from the checked-in OpenAPI document.
 * Other systems can copy this package or generate their own client from /api/v1/openapi.json.
 */
export function createHrClient(options: ClientOptions & { token?: () => string | null | undefined | Promise<string | null | undefined> }) {
  const client = createClient<paths>(options);
  if (options.token) {
    const getToken = options.token;
    client.use({
      async onRequest({ request }) {
        const token = await getToken();
        if (token) request.headers.set('Authorization', `Bearer ${token}`);
        return request;
      },
    });
  }
  return client;
}
export type HrClient = ReturnType<typeof createHrClient>;
