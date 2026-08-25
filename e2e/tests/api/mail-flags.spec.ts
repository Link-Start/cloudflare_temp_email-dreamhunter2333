import { test, expect } from '@playwright/test';
import {
  WORKER_URL,
  createTestAddress,
  deleteAddress,
  seedTestMail,
} from '../../fixtures/test-helpers';

test.describe('Mail Flags', () => {
  test('new mail is unread and can be marked as read without changing other mailboxes', async ({ request }) => {
    const first = await createTestAddress(request, 'mail-flags-first');
    const second = await createTestAddress(request, 'mail-flags-second');

    try {
      await seedTestMail(request, first.address, { subject: 'Unread mail' });
      const listRes = await request.get(`${WORKER_URL}/api/mails?limit=10&offset=0`, {
        headers: { Authorization: `Bearer ${first.jwt}` },
      });
      expect(listRes.ok()).toBe(true);
      const { results } = await listRes.json();
      expect(results).toHaveLength(1);
      expect(results[0].flags).toBe(1);

      const unreadRes = await request.get(
        `${WORKER_URL}/api/mails?limit=10&offset=0&flag=0&flag_state=set`,
        { headers: { Authorization: `Bearer ${first.jwt}` } },
      );
      expect((await unreadRes.json()).results).toHaveLength(1);

      const deniedRes = await request.patch(`${WORKER_URL}/api/mails/flags`, {
        headers: { Authorization: `Bearer ${second.jwt}` },
        data: { ids: [results[0].id], add: 0, remove: 1 },
      });
      expect(deniedRes.ok()).toBe(true);
      expect((await deniedRes.json()).changes).toBe(0);

      const updateRes = await request.patch(`${WORKER_URL}/api/mails/flags`, {
        headers: { Authorization: `Bearer ${first.jwt}` },
        data: { ids: [results[0].id], add: 0, remove: 1 },
      });
      expect(updateRes.ok()).toBe(true);
      expect((await updateRes.json()).changes).toBe(1);

      const updatedListRes = await request.get(`${WORKER_URL}/api/mails?limit=10&offset=0`, {
        headers: { Authorization: `Bearer ${first.jwt}` },
      });
      expect((await updatedListRes.json()).results[0].flags).toBe(0);

      const unreadAfterUpdateRes = await request.get(
        `${WORKER_URL}/api/mails?limit=10&offset=0&flag=0&flag_state=set`,
        { headers: { Authorization: `Bearer ${first.jwt}` } },
      );
      expect((await unreadAfterUpdateRes.json()).results).toHaveLength(0);
    } finally {
      await deleteAddress(request, first.jwt);
      await deleteAddress(request, second.jwt);
    }
  });

  test('rejects unsupported and overlapping flag masks', async ({ request }) => {
    const { jwt } = await createTestAddress(request, 'mail-flags-invalid');
    try {
      for (const data of [
        { ids: [1], add: 4, remove: 0 },
        { ids: [1], add: 1, remove: 1 },
      ]) {
        const res = await request.patch(`${WORKER_URL}/api/mails/flags`, {
          headers: { Authorization: `Bearer ${jwt}` },
          data,
        });
        expect(res.status()).toBe(400);
      }
    } finally {
      await deleteAddress(request, jwt);
    }
  });
});
