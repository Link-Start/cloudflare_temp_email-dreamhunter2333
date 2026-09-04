import { expect, test } from '@playwright/test';
import {
  WORKER_URL_ENV_OFF,
  WORKER_URL_SITE_PASSWORD,
} from '../../fixtures/test-helpers';

const SITE_HEADERS = { 'x-custom-auth': 'e2e-site-pass' };
const futureExpiration = () => new Date(Date.now() + 3_600_000).toISOString();

test.describe('Redemption feature access boundaries', () => {
  test('the disabled switch hides every user and Admin endpoint', async ({ request }) => {
    const settingsResponse = await request.get(`${WORKER_URL_ENV_OFF}/open_api/settings`);
    expect(settingsResponse.ok()).toBe(true);
    expect((await settingsResponse.json()).enableRedeemCode).toBe(false);

    const requests = [
      request.post(`${WORKER_URL_ENV_OFF}/redeem_api/query`, { data: { code: 'anything' } }),
      request.post(`${WORKER_URL_ENV_OFF}/redeem_api/result`, { data: { code: 'anything' } }),
      request.post(`${WORKER_URL_ENV_OFF}/redeem_api/redeem`, {
        data: { code: 'anything', user_email: 'user@test.example.com' },
      }),
      request.get(`${WORKER_URL_ENV_OFF}/admin/redeem_codes?redeem_type=role`),
      request.get(`${WORKER_URL_ENV_OFF}/admin/redeem_codes/export?redeem_type=role&limit=1`),
      request.post(`${WORKER_URL_ENV_OFF}/admin/redeem_codes/batch`, {
        data: {
          count: 1,
          redeem_type: 'role',
          value: 'case-role',
          enabled: true,
          expires_at: futureExpiration(),
        },
      }),
      request.put(`${WORKER_URL_ENV_OFF}/admin/redeem_codes/1`, {
        data: {
          redeem_type: 'role',
          value: 'case-role',
          enabled: true,
          expires_at: futureExpiration(),
        },
      }),
      request.delete(`${WORKER_URL_ENV_OFF}/admin/redeem_codes/1`),
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) {
      expect(response.status()).toBe(404);
    }
  });

  test('site password takes priority over otherwise public redemption APIs', async ({ request }) => {
    const settingsResponse = await request.get(`${WORKER_URL_SITE_PASSWORD}/open_api/settings`);
    expect(settingsResponse.ok()).toBe(true);
    expect(await settingsResponse.json()).toMatchObject({
      needAuth: true,
      enableRedeemCode: true,
    });

    const blockedAdminResponse = await request.post(
      `${WORKER_URL_SITE_PASSWORD}/admin/redeem_codes/batch`,
      {
        data: {
          count: 1,
          redeem_type: 'role',
          value: 'case-role',
          enabled: true,
          expires_at: futureExpiration(),
        },
      },
    );
    expect(blockedAdminResponse.status()).toBe(401);

    const createResponse = await request.post(
      `${WORKER_URL_SITE_PASSWORD}/admin/redeem_codes/batch`,
      {
        headers: SITE_HEADERS,
        data: {
          count: 1,
          redeem_type: 'role',
          value: 'case-role',
          enabled: true,
          expires_at: futureExpiration(),
        },
      },
    );
    expect(createResponse.ok()).toBe(true);
    const code = (await createResponse.json()).codes[0] as string;

    for (const path of ['query', 'result', 'redeem']) {
      const missingPassword = await request.post(
        `${WORKER_URL_SITE_PASSWORD}/redeem_api/${path}`,
        { data: { code } },
      );
      expect(missingPassword.status()).toBe(401);
      const wrongPassword = await request.post(
        `${WORKER_URL_SITE_PASSWORD}/redeem_api/${path}`,
        { headers: { 'x-custom-auth': 'wrong' }, data: { code } },
      );
      expect(wrongPassword.status()).toBe(401);
    }
    const validPassword = await request.post(`${WORKER_URL_SITE_PASSWORD}/redeem_api/query`, {
      headers: SITE_HEADERS,
      data: { code },
    });
    expect(validPassword.ok()).toBe(true);
    expect(await validPassword.json()).toEqual({
      redeem_type: 'role', value: 'case-role', status: 'unused',
    });

    const listResponse = await request.get(
      `${WORKER_URL_SITE_PASSWORD}/admin/redeem_codes?redeem_type=role`
      + `&limit=20&offset=0&query=${encodeURIComponent(code)}`,
      { headers: SITE_HEADERS },
    );
    const row = (await listResponse.json()).results[0];
    const deleteResponse = await request.delete(
      `${WORKER_URL_SITE_PASSWORD}/admin/redeem_codes/${row.id}`,
      { headers: SITE_HEADERS },
    );
    expect(deleteResponse.ok()).toBe(true);
  });

  test('special-address redemption preserves the configured address regex', async ({ request }) => {
    const createResponse = await request.post(
      `${WORKER_URL_SITE_PASSWORD}/admin/redeem_codes/batch`,
      {
        headers: SITE_HEADERS,
        data: {
          count: 1,
          redeem_type: 'address_prefix_once',
          value: '',
          enabled: true,
          expires_at: futureExpiration(),
        },
      },
    );
    expect(createResponse.ok()).toBe(true);
    const code = (await createResponse.json()).codes[0] as string;

    const redeemResponse = await request.post(
      `${WORKER_URL_SITE_PASSWORD}/redeem_api/redeem`,
      {
        headers: SITE_HEADERS,
        data: { code, name: 'blocked', domain: 'test.example.com' },
      },
    );
    expect(redeemResponse.status()).toBe(400);

    const queryResponse = await request.post(
      `${WORKER_URL_SITE_PASSWORD}/redeem_api/query`,
      { headers: SITE_HEADERS, data: { code } },
    );
    expect(queryResponse.ok()).toBe(true);

    const listResponse = await request.get(
      `${WORKER_URL_SITE_PASSWORD}/admin/redeem_codes?redeem_type=address_prefix_once`
      + `&limit=20&offset=0&query=${encodeURIComponent(code)}`,
      { headers: SITE_HEADERS },
    );
    const row = (await listResponse.json()).results[0];
    const deleteResponse = await request.delete(
      `${WORKER_URL_SITE_PASSWORD}/admin/redeem_codes/${row.id}`,
      { headers: SITE_HEADERS },
    );
    expect(deleteResponse.ok()).toBe(true);
  });
});
