import { expect, request as apiRequest, test } from '@playwright/test';

import {
  FRONTEND_URL,
  WORKER_URL,
  createTestAddress,
  deleteAddress,
  seedTestMail,
} from '../../fixtures/test-helpers';

test.describe('Mail state browser flow', () => {
  test('does not mark the initial desktop preview as read before a click', async ({ page }) => {
    const request = await apiRequest.newContext();
    let jwt: string | undefined;

    try {
      const mailbox = await createTestAddress(request, 'mail-preview-unread');
      jwt = mailbox.jwt;
      const subject = `Preview unread ${Date.now()}`;
      await seedTestMail(request, mailbox.address, { subject });

      await page.goto(`${FRONTEND_URL}/en/`);
      await page.evaluate(() => localStorage.setItem('mailListView', 'false'));
      await page.goto(`${FRONTEND_URL}/en/?jwt=${jwt}`);
      await expect(page.getByText(subject, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      await page.waitForLoadState('networkidle');

      const beforeClick = await request.get(
        `${WORKER_URL}/api/mails?limit=10&offset=0&mail_state=unread`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect((await beforeClick.json()).results).toHaveLength(1);

      const readResponse = page.waitForResponse((response) => {
        return new URL(response.url()).pathname === '/api/mails/state'
          && response.request().method() === 'PATCH';
      });
      await page.getByText(subject, { exact: true }).first().click();
      expect((await readResponse).ok()).toBe(true);

      const afterClick = await request.get(
        `${WORKER_URL}/api/mails?limit=10&offset=0&mail_state=unread`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect((await afterClick.json()).results).toHaveLength(0);
    } finally {
      try {
        if (jwt) await deleteAddress(request, jwt);
      } finally {
        await request.dispose();
      }
    }
  });

  test('opens, toggles, filters and marks the current page read', async ({ page }) => {
    const request = await apiRequest.newContext();
    let jwt: string | undefined;

    try {
      const mailbox = await createTestAddress(request, 'mail-flags-browser');
      jwt = mailbox.jwt;
      const subjects = [`Unread A ${Date.now()}`, `Unread B ${Date.now()}`];
      for (const subject of subjects) {
        await seedTestMail(request, mailbox.address, { subject });
      }

      await page.goto(`${FRONTEND_URL}/en/`);
      await page.evaluate(() => localStorage.setItem('mailListView', 'true'));
      await page.goto(`${FRONTEND_URL}/en/?jwt=${jwt}`);

      for (const subject of subjects) {
        await expect(page.getByText(subject, { exact: true })).toBeVisible({ timeout: 10_000 });
      }
      await expect(page.getByText('Unread', { exact: true })).toHaveCount(2);

      const openStateResponse = page.waitForResponse((response) => {
        return new URL(response.url()).pathname === '/api/mails/state'
          && response.request().method() === 'PATCH';
      });
      await page.getByText(subjects[0], { exact: true }).click();
      expect((await openStateResponse).ok()).toBe(true);
      await expect(page.getByRole('button', { name: 'Mark as Unread' })).toBeVisible();

      const flaggedResponse = page.waitForResponse((response) => {
        return new URL(response.url()).pathname === '/api/mails/flagged'
          && response.request().method() === 'PATCH';
      });
      await page.locator('.mail-content-renderer').getByRole('button', { name: 'Add Star' }).click();
      expect((await flaggedResponse).ok()).toBe(true);
      await expect(
        page.locator('.mail-content-renderer').getByRole('button', { name: 'Remove Star' }),
      ).toBeVisible();

      const unreadAfterOpen = await request.get(
        `${WORKER_URL}/api/mails?limit=10&offset=0&mail_state=unread`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect((await unreadAfterOpen.json()).results).toHaveLength(1);

      const toggleResponse = page.waitForResponse((response) => {
        return new URL(response.url()).pathname === '/api/mails/state'
          && response.request().method() === 'PATCH';
      });
      await page.getByRole('button', { name: 'Mark as Unread' }).click();
      expect((await toggleResponse).ok()).toBe(true);
      await expect(page.getByRole('button', { name: 'Mark as Read' })).toBeVisible();

      await page.getByRole('button', { name: 'Back to List' }).click();

      const flaggedFilterResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/mails' && url.searchParams.get('flagged') === 'true';
      });
      await page.getByRole('checkbox', { name: 'Flagged' }).check();
      expect((await flaggedFilterResponse).ok()).toBe(true);
      await expect(page.getByText(subjects[0], { exact: true })).toBeVisible();
      await expect(page.getByText(subjects[1], { exact: true })).toHaveCount(0);
      const allMailResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/mails' && !url.searchParams.has('flagged');
      });
      await page.getByRole('checkbox', { name: 'Flagged' }).uncheck();
      expect((await allMailResponse).ok()).toBe(true);

      const pageReadResponse = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== '/api/mails/state') return false;
        if (response.request().method() !== 'PATCH') return false;
        const body = response.request().postDataJSON();
        return body.state === 'read' && body.ids.length === 2;
      });
      await page.getByRole('button', { name: 'Mark This Page as Read' }).click();
      expect((await pageReadResponse).ok()).toBe(true);
      await expect(page.getByRole('button', { name: 'Mark This Page as Read' })).toBeHidden();

      const unreadAfterPage = await request.get(
        `${WORKER_URL}/api/mails?limit=10&offset=0&mail_state=unread`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect((await unreadAfterPage.json()).results).toHaveLength(0);

      const unreadFilterResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/mails' && url.searchParams.get('mail_state') === 'unread';
      });
      const stateSelect = page.locator('.n-select').filter({ hasText: 'All Mail' }).first();
      await stateSelect.click();
      await page.locator('.n-base-select-option').filter({ hasText: /^Unread$/ }).click();
      expect((await unreadFilterResponse).ok()).toBe(true);
      for (const subject of subjects) {
        await expect(page.getByText(subject, { exact: true })).toHaveCount(0);
      }
    } finally {
      try {
        if (jwt) await deleteAddress(request, jwt);
      } finally {
        await request.dispose();
      }
    }
  });
});
