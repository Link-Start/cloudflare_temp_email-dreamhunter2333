import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  WORKER_URL,
  WORKER_URL_ENV_OFF,
  WORKER_GZIP_URL,
  WORKER_URL_SEND_MAIL_DOMAIN,
  createTestAddress,
  deleteAddress,
  hashPassword,
  seedTestMail,
} from '../../fixtures/test-helpers';

const addressHeaders = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

async function createAddressAt(
  request: APIRequestContext,
  baseUrl: string,
  name: string,
  domain: string,
) {
  const response = await request.post(`${baseUrl}/api/new_address`, {
    data: { name: `${name}${Date.now()}`, domain },
  });
  expect(response.ok()).toBe(true);
  return await response.json();
}

async function receiveMailAt(
  request: APIRequestContext,
  baseUrl: string,
  address: string,
) {
  const raw = [
    'From: sender@example.com',
    `To: ${address}`,
    `Subject: Split flags ${Date.now()}`,
    '',
    'Split flags body',
  ].join('\r\n');
  const response = await request.post(`${baseUrl}/admin/test/receive_mail`, {
    data: { from: 'sender@example.com', to: address, raw },
  });
  expect(response.ok()).toBe(true);
}

async function listMails(
  request: APIRequestContext,
  jwt: string,
  state = 'all',
  baseUrl = WORKER_URL,
) {
  const response = await request.get(
    `${baseUrl}/api/mails?limit=100&offset=0&mail_state=${state}`,
    { headers: addressHeaders(jwt) },
  );
  expect(response.ok()).toBe(true);
  return await response.json();
}

async function updateState(
  request: APIRequestContext,
  jwt: string,
  ids: number[],
  state: string,
) {
  const response = await request.patch(`${WORKER_URL}/api/mails/state`, {
    headers: addressHeaders(jwt),
    data: { ids, state },
  });
  expect(response.ok()).toBe(true);
  return await response.json();
}

async function updateFlagged(
  request: APIRequestContext,
  jwt: string,
  ids: number[],
  flagged: boolean,
) {
  const response = await request.patch(`${WORKER_URL}/api/mails/flagged`, {
    headers: addressHeaders(jwt),
    data: { ids, flagged },
  });
  expect(response.ok()).toBe(true);
  return await response.json();
}

test.describe('Mail states', () => {
  test('read status and Flagged switches are independent', async ({ request }) => {
    test.skip(
      !WORKER_GZIP_URL || !WORKER_URL_SEND_MAIL_DOMAIN,
      'Mixed feature workers are not configured',
    );

    const readOnly = await createAddressAt(
      request, WORKER_GZIP_URL, 'mail-read-only', 'test.example.com',
    );
    const flaggedOnly = await createAddressAt(
      request, WORKER_URL_SEND_MAIL_DOMAIN, 'mail-flagged-only', 'TEST.EXAMPLE.COM',
    );

    try {
      await receiveMailAt(request, WORKER_GZIP_URL, readOnly.address);
      await receiveMailAt(request, WORKER_URL_SEND_MAIL_DOMAIN, flaggedOnly.address);

      const readSettings = await (await request.get(
        `${WORKER_GZIP_URL}/open_api/settings`,
      )).json();
      expect(readSettings.enableMailReadStatus).toBe(true);
      expect(readSettings).not.toHaveProperty('enableMailFlagged');

      const flaggedSettings = await (await request.get(
        `${WORKER_URL_SEND_MAIL_DOMAIN}/open_api/settings`,
      )).json();
      expect(flaggedSettings).not.toHaveProperty('enableMailReadStatus');
      expect(flaggedSettings.enableMailFlagged).toBe(true);

      const readList = await request.get(
        `${WORKER_GZIP_URL}/api/mails?limit=10&offset=0`,
        { headers: addressHeaders(readOnly.jwt) },
      );
      const readMail = (await readList.json()).results[0];
      expect(readMail.unread).toBe(true);
      expect(readMail).not.toHaveProperty('flagged');
      expect((await request.get(`${WORKER_GZIP_URL}/api/mail-states`, {
        headers: addressHeaders(readOnly.jwt),
      })).ok()).toBe(true);
      expect((await request.patch(`${WORKER_GZIP_URL}/api/mails/flagged`, {
        headers: addressHeaders(readOnly.jwt),
        data: { ids: [readMail.id], flagged: true },
      })).status()).toBe(403);

      const flaggedList = await request.get(
        `${WORKER_URL_SEND_MAIL_DOMAIN}/api/mails?limit=10&offset=0`,
        { headers: addressHeaders(flaggedOnly.jwt) },
      );
      const flaggedMail = (await flaggedList.json()).results[0];
      expect(flaggedMail).not.toHaveProperty('unread');
      expect(flaggedMail.flagged).toBe(false);
      expect((await request.get(`${WORKER_URL_SEND_MAIL_DOMAIN}/api/mail-states`, {
        headers: addressHeaders(flaggedOnly.jwt),
      })).status()).toBe(403);
      const addedStar = await request.patch(
        `${WORKER_URL_SEND_MAIL_DOMAIN}/api/mails/flagged`,
        {
          headers: addressHeaders(flaggedOnly.jwt),
          data: { ids: [flaggedMail.id], flagged: true },
        },
      );
      expect((await addedStar.json()).results).toEqual([{ id: flaggedMail.id, flagged: true }]);
    } finally {
      await Promise.allSettled([
        request.delete(`${WORKER_GZIP_URL}/admin/delete_address/${readOnly.address_id}`),
        request.delete(
          `${WORKER_URL_SEND_MAIL_DOMAIN}/admin/delete_address/${flaggedOnly.address_id}`,
        ),
      ]);
    }
  });

  test('supports unread lifecycle, historical mail, filtering and mailbox isolation', async ({ request }) => {
    const first = await createTestAddress(request, 'mail-state-first');
    const second = await createTestAddress(request, 'mail-state-second');

    try {
      const historical = await request.post(`${WORKER_URL}/admin/test/seed_mail`, {
        data: { address: first.address, raw: 'Historical mail' },
      });
      expect(historical.ok()).toBe(true);

      await seedTestMail(request, first.address, { subject: 'Unread one' });
      await seedTestMail(request, first.address, { subject: 'Unread two' });
      await seedTestMail(request, second.address, { subject: 'Other mailbox' });

      const states = await request.get(`${WORKER_URL}/api/mail-states`, {
        headers: addressHeaders(first.jwt),
      });
      expect(states.ok()).toBe(true);
      expect((await states.json()).results.map((state: { value: string }) => state.value))
        .toEqual(['all', 'unread', 'read']);

      const initial = await listMails(request, first.jwt);
      expect(initial.count).toBe(3);
      expect(initial.results.filter((mail: { unread: boolean }) => mail.unread)).toHaveLength(2);
      expect(initial.results.filter((mail: { unread: boolean }) => !mail.unread)).toHaveLength(1);
      expect(initial.results.every((mail: { flagged: boolean }) => !mail.flagged)).toBe(true);

      const unreadIds = initial.results
        .filter((mail: { unread: boolean }) => mail.unread)
        .map((mail: { id: number }) => mail.id);
      const denied = await updateState(request, second.jwt, [unreadIds[0]], 'read');
      expect(denied.changes).toBe(0);
      const deniedStar = await updateFlagged(request, second.jwt, [unreadIds[0]], true);
      expect(deniedStar.changes).toBe(0);

      const addedStar = await updateFlagged(request, first.jwt, [unreadIds[0]], true);
      expect(addedStar.results).toEqual([{ id: unreadIds[0], flagged: true }]);

      const markedRead = await updateState(request, first.jwt, unreadIds, 'read');
      expect(markedRead.changes).toBe(2);
      expect(markedRead.results.every((mail: { unread: boolean }) => !mail.unread)).toBe(true);
      expect((await listMails(request, first.jwt, 'unread')).results).toHaveLength(0);
      expect((await listMails(request, first.jwt, 'read')).results).toHaveLength(3);

      const flagged = await request.get(
        `${WORKER_URL}/api/mails?limit=100&offset=0&mail_state=read&flagged=true`,
        { headers: addressHeaders(first.jwt) },
      );
      const flaggedMails = (await flagged.json()).results;
      expect(flaggedMails).toHaveLength(1);
      expect(flaggedMails[0]).toMatchObject({ id: unreadIds[0], unread: false, flagged: true });

      const markedUnread = await updateState(request, first.jwt, [unreadIds[0]], 'unread');
      expect(markedUnread.results).toEqual([{ id: unreadIds[0], unread: true }]);
      expect((await listMails(request, first.jwt, 'unread')).results).toHaveLength(1);

      const detail = await request.get(`${WORKER_URL}/api/mail/${unreadIds[0]}`, {
        headers: addressHeaders(first.jwt),
      });
      expect(await detail.json()).toMatchObject({ unread: true, flagged: true });

      await updateFlagged(request, first.jwt, [unreadIds[0]], false);
      const noFlagged = await request.get(
        `${WORKER_URL}/api/mails?limit=100&offset=0&flagged=true`,
        { headers: addressHeaders(first.jwt) },
      );
      expect((await noFlagged.json()).results).toHaveLength(0);

      const invalid = await request.patch(`${WORKER_URL}/api/mails/state`, {
        headers: addressHeaders(first.jwt),
        data: { ids: [unreadIds[0]], state: 'unknown' },
      });
      expect(invalid.status()).toBe(400);
    } finally {
      await deleteAddress(request, first.jwt);
      await deleteAddress(request, second.jwt);
    }
  });

  test('user APIs only expose and update bound-address mail', async ({ request }) => {
    let originalSettings: Record<string, unknown> | undefined;
    let userId: number | undefined;
    const mailboxes: Awaited<ReturnType<typeof createTestAddress>>[] = [];

    try {
      const settings = await request.get(`${WORKER_URL}/admin/user_settings`);
      originalSettings = await settings.json();
      await request.post(`${WORKER_URL}/admin/user_settings`, {
        data: { ...originalSettings, enable: true, enableMailVerify: false, maxAddressCount: 0 },
      });

      const email = `mail-state-user-${Date.now()}@test.example.com`;
      const password = hashPassword('mail-state-password');
      expect((await request.post(`${WORKER_URL}/user_api/register`, {
        data: { email, password },
      })).ok()).toBe(true);
      const login = await request.post(`${WORKER_URL}/user_api/login`, {
        data: { email, password },
      });
      const { jwt: userJwt } = await login.json();
      userId = JSON.parse(Buffer.from(userJwt.split('.')[1], 'base64url').toString()).user_id;

      const bound = await createTestAddress(request, 'mail-state-bound');
      const outsider = await createTestAddress(request, 'mail-state-outsider');
      mailboxes.push(bound, outsider);
      const bind = await request.post(`${WORKER_URL}/user_api/bind_address`, {
        headers: { ...addressHeaders(bound.jwt), 'x-user-token': userJwt },
      });
      expect(bind.ok()).toBe(true);

      await seedTestMail(request, bound.address, { subject: 'Bound unread' });
      await seedTestMail(request, outsider.address, { subject: 'Outsider unread' });

      const userList = await request.get(
        `${WORKER_URL}/user_api/mails?limit=20&offset=0&mail_state=unread`,
        { headers: { 'x-user-token': userJwt } },
      );
      const userMails = await userList.json();
      expect(userMails.results).toHaveLength(1);
      expect(userMails.results[0].address).toBe(bound.address);

      const outsiderMail = (await listMails(request, outsider.jwt)).results[0];
      const denied = await request.patch(`${WORKER_URL}/user_api/mails/state`, {
        headers: { 'x-user-token': userJwt },
        data: { ids: [outsiderMail.id], state: 'read' },
      });
      expect((await denied.json()).changes).toBe(0);

      const update = await request.patch(`${WORKER_URL}/user_api/mails/state`, {
        headers: { 'x-user-token': userJwt },
        data: { ids: [userMails.results[0].id], state: 'read' },
      });
      expect((await update.json()).results[0].unread).toBe(false);

      const addStar = await request.patch(`${WORKER_URL}/user_api/mails/flagged`, {
        headers: { 'x-user-token': userJwt },
        data: { ids: [userMails.results[0].id], flagged: true },
      });
      expect((await addStar.json()).results[0].flagged).toBe(true);

      const flagged = await request.get(
        `${WORKER_URL}/user_api/mails?limit=20&offset=0&flagged=true`,
        { headers: { 'x-user-token': userJwt } },
      );
      expect((await flagged.json()).results).toHaveLength(1);
    } finally {
      await Promise.allSettled(mailboxes.map(mailbox => deleteAddress(request, mailbox.jwt)));
      if (userId !== undefined) await request.delete(`${WORKER_URL}/admin/users/${userId}`);
      if (originalSettings) {
        await request.post(`${WORKER_URL}/admin/user_settings`, { data: originalSettings });
      }
    }
  });

  test('disabled feature keeps existing responses unchanged', async ({ request }) => {
    test.skip(!WORKER_URL_ENV_OFF, 'WORKER_URL_ENV_OFF is not configured');

    const created = await request.post(`${WORKER_URL_ENV_OFF}/api/new_address`, {
      data: { name: `mail-state-off-${Date.now()}`, domain: 'test.example.com' },
    });
    const mailbox = await created.json();

    try {
      const raw = [
        'From: sender@example.com',
        `To: ${mailbox.address}`,
        'Subject: States disabled',
        '',
        'Disabled body',
      ].join('\r\n');
      await request.post(`${WORKER_URL_ENV_OFF}/admin/test/receive_mail`, {
        data: { from: 'sender@example.com', to: mailbox.address, raw },
      });

      const list = await request.get(`${WORKER_URL_ENV_OFF}/api/mails?limit=10&offset=0`, {
        headers: addressHeaders(mailbox.jwt),
      });
      const body = await list.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).not.toHaveProperty('unread');
      expect(body.results[0]).not.toHaveProperty('flagged');

      const states = await request.get(`${WORKER_URL_ENV_OFF}/api/mail-states`, {
        headers: addressHeaders(mailbox.jwt),
      });
      expect(states.status()).toBe(403);
      const update = await request.patch(`${WORKER_URL_ENV_OFF}/api/mails/state`, {
        headers: addressHeaders(mailbox.jwt),
        data: { ids: [body.results[0].id], state: 'read' },
      });
      expect(update.status()).toBe(403);
      const disabledFlagUpdate = await request.patch(`${WORKER_URL_ENV_OFF}/api/mails/flagged`, {
        headers: addressHeaders(mailbox.jwt),
        data: { ids: [body.results[0].id], flagged: true },
      });
      expect(disabledFlagUpdate.status()).toBe(403);
    } finally {
      await request.delete(`${WORKER_URL_ENV_OFF}/admin/delete_address/${mailbox.address_id}`);
    }
  });
});
