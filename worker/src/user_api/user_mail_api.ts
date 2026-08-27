import { Context } from "hono";
import i18n from "../i18n";
import { handleMailListQuery } from "../common";
import { getBooleanValue } from "../utils";
import {
    getMailStateQuery,
    getMailFlaggedQuery,
    getMailStateOptions,
    applyMailStateUpdate,
    applyMailFlaggedUpdate,
    deleteRawMails,
    isMailReadStatusEnabled,
    isMailFlaggedEnabled,
} from "../mail_flags";

export default {
    getMailStates: (c: Context<HonoCustomType>) => {
        if (!isMailReadStatusEnabled(c.env)) {
            return c.json({ error: "Mail read status is disabled" }, 403);
        }
        return c.json({ results: getMailStateOptions() });
    },
    getMails: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address, limit, offset, mail_state, flagged } = c.req.query();
        const filterQuerys = [`ua.user_id = ?`];
        const filterParams = [String(user_id)];
        if (address) {
            filterQuerys.push(`rm.address = ?`);
            filterParams.push(address);
        }
        const stateQuery = getMailStateQuery(mail_state, 'rm', 'a.id');
        const flaggedQuery = getMailFlaggedQuery(flagged, 'rm', 'a.id');
        if (stateQuery === null) return c.json({ error: "Invalid mail state filter" }, 400);
        if (flaggedQuery === null) return c.json({ error: "Invalid flagged filter" }, 400);
        if (stateQuery && !isMailReadStatusEnabled(c.env)) {
            return c.json({ error: "Mail read status is disabled" }, 403);
        }
        if (flaggedQuery && !isMailFlaggedEnabled(c.env)) {
            return c.json({ error: "Flagged mail is disabled" }, 403);
        }
        if (stateQuery?.clause) filterQuerys.push(stateQuery.clause);
        if (flaggedQuery?.clause) filterQuerys.push(flaggedQuery.clause);
        const fromQuery = ` FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` JOIN raw_mails rm ON rm.address = a.name`
            + (stateQuery?.join ?? '')
            + (flaggedQuery?.join ?? '')
            + ` WHERE ${filterQuerys.join(" AND ")}`;
        const unreadSelect = stateQuery?.unread === undefined
            ? ''
            : `, ${stateQuery.unread ? 1 : 0} AS unread`;
        const flaggedSelect = flaggedQuery?.flagged === undefined
            ? ''
            : `, ${flaggedQuery.flagged ? 1 : 0} AS flagged`;
        return await handleMailListQuery(c,
            `SELECT rm.*${unreadSelect}${flaggedSelect}${fromQuery}`,
            `SELECT count(*) as count${fromQuery}`,
            [...(stateQuery?.params ?? []), ...(flaggedQuery?.params ?? []), ...filterParams],
            limit, offset, flaggedQuery?.orderBy ?? stateQuery?.orderBy ?? 'rm.id desc'
        );
    },
    deleteMail: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
            return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
        }
        const { id } = c.req.param();
        const { user_id } = c.get("userPayload");
        const { success } = await deleteRawMails(
            c.env.DB,
            c.env,
            `id = ?`
            + ` AND EXISTS (`
            + `SELECT 1 FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` WHERE ua.user_id = ? AND a.name = raw_mails.address`
            + `)`,
            [id, user_id],
        );
        return c.json({
            success: success
        })
    },
    updateMailState: async (c: Context<HonoCustomType>) => {
        if (!isMailReadStatusEnabled(c.env)) {
            return c.json({ error: "Mail read status is disabled" }, 403);
        }
        const { user_id } = c.get("userPayload");
        const result = await applyMailStateUpdate(
            c.env.DB,
            {
                clause: `a.id IN (`
                    + `SELECT address_id FROM users_address WHERE user_id = ?`
                    + `)`,
                params: [user_id],
            },
            await c.req.json().catch(() => null),
        );
        if (!result) return c.json({ error: "Invalid mail state request" }, 400);
        if (!result.success) return c.json(result, 500);
        return c.json(result);
    },
    updateMailFlagged: async (c: Context<HonoCustomType>) => {
        if (!isMailFlaggedEnabled(c.env)) {
            return c.json({ error: "Flagged mail is disabled" }, 403);
        }
        const { user_id } = c.get("userPayload");
        const result = await applyMailFlaggedUpdate(
            c.env.DB,
            {
                clause: `a.id IN (`
                    + `SELECT address_id FROM users_address WHERE user_id = ?`
                    + `)`,
                params: [user_id],
            },
            await c.req.json().catch(() => null),
        );
        if (!result) return c.json({ error: "Invalid flagged request" }, 400);
        if (!result.success) return c.json(result, 500);
        return c.json(result);
    }
}
