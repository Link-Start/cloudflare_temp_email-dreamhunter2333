import { test, expect } from '@playwright/test';
import {
  WORKER_URL,
  createTestAddress,
  deleteAddress,
  seedTestMail,
} from '../../fixtures/test-helpers';

test.describe('Mail Read Status', () => {
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
      expect(results[0].flags).toBeUndefined();
      expect(results[0].unread).toBe(true);

      const unreadRes = await request.get(
        `${WORKER_URL}/api/mails?limit=10&offset=0&read_status=unread`,
        { headers: { Authorization: `Bearer ${first.jwt}` } },
      );
      expect((await unreadRes.json()).results).toHaveLength(1);

      const deniedRes = await request.patch(`${WORKER_URL}/api/mails/read-status`, {
        headers: { Authorization: `Bearer ${second.jwt}` },
        data: { ids: [results[0].id], action: 'read' },
      });
      expect(deniedRes.ok()).toBe(true);
      expect((await deniedRes.json()).changes).toBe(0);

      const updateRes = await request.patch(`${WORKER_URL}/api/mails/read-status`, {
        headers: { Authorization: `Bearer ${first.jwt}` },
        data: { ids: [results[0].id], action: 'read' },
      });
      expect(updateRes.ok()).toBe(true);
      const updateResult = await updateRes.json();
      expect(updateResult.changes).toBe(1);
      expect(updateResult.results[0].unread).toBe(false);

      const updatedListRes = await request.get(`${WORKER_URL}/api/mails?limit=10&offset=0`, {
        headers: { Authorization: `Bearer ${first.jwt}` },
      });
      expect((await updatedListRes.json()).results[0].unread).toBe(false);

      const unreadAfterUpdateRes = await request.get(
        `${WORKER_URL}/api/mails?limit=10&offset=0&read_status=unread`,
        { headers: { Authorization: `Bearer ${first.jwt}` } },
      );
      expect((await unreadAfterUpdateRes.json()).results).toHaveLength(0);

      const toggleRes = await request.patch(`${WORKER_URL}/api/mails/read-status`, {
        headers: { Authorization: `Bearer ${first.jwt}` },
        data: { ids: [results[0].id], action: 'toggle' },
      });
      expect(toggleRes.ok()).toBe(true);
      expect((await toggleRes.json()).results[0].unread).toBe(true);
    } finally {
      await deleteAddress(request, first.jwt);
      await deleteAddress(request, second.jwt);
    }
  });

  test('rejects unsupported read-status actions', async ({ request }) => {
    const { jwt } = await createTestAddress(request, 'mail-flags-invalid');
    try {
      for (const data of [
        { ids: [1], action: 'invalid' },
        { ids: [1] },
      ]) {
        const res = await request.patch(`${WORKER_URL}/api/mails/read-status`, {
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
