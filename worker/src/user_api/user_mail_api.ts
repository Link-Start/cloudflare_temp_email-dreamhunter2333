import { Context } from "hono";
import i18n from "../i18n";
import { handleMailListQuery } from "../common";
import { getBooleanValue } from "../utils";
import {
    getMailStateQuery,
    getMailStateOptions,
    applyMailStateUpdate,
} from "../mail_flags";

export default {
    getMailStates: (c: Context<HonoCustomType>) => {
        if (!getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
            return c.json({ error: "Mail states are disabled" }, 403);
        }
        return c.json({ results: getMailStateOptions() });
    },
    getMails: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address, limit, offset, mail_state } = c.req.query();
        const filterQuerys = [`ua.user_id = ?`];
        const filterParams = [String(user_id)];
        if (address) {
            filterQuerys.push(`rm.address = ?`);
            filterParams.push(address);
        }
        const stateQuery = getMailStateQuery(mail_state, 'rm.flags');
        if (stateQuery === null) return c.json({ error: "Invalid mail state filter" }, 400);
        if (stateQuery && !getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
            return c.json({ error: "Mail states are disabled" }, 403);
        }
        if (stateQuery) {
            filterQuerys.push(stateQuery.clause);
            filterParams.push(...stateQuery.params);
        }
        const fromQuery = ` FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` JOIN raw_mails rm ON rm.address = a.name`
            + ` WHERE ${filterQuerys.join(" AND ")}`;
        return await handleMailListQuery(c,
            `SELECT rm.*${fromQuery}`,
            `SELECT count(*) as count${fromQuery}`,
            filterParams, limit, offset, 'rm.id desc'
        );
    },
    deleteMail: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
            return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
        }
        const { id } = c.req.param();
        const { user_id } = c.get("userPayload");
        const { success } = await c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE id = ?`
            + ` AND EXISTS (`
            + `SELECT 1 FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` WHERE ua.user_id = ? AND a.name = raw_mails.address`
            + `)`
        ).bind(id, user_id).run();
        return c.json({
            success: success
        })
    },
    updateMailState: async (c: Context<HonoCustomType>) => {
        if (!getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
            return c.json({ error: "Mail states are disabled" }, 403);
        }
        const { user_id } = c.get("userPayload");
        const result = await applyMailStateUpdate(
            c.env.DB,
            {
                clause: `EXISTS (`
                + `SELECT 1 FROM users_address ua`
                + ` JOIN address a ON a.id = ua.address_id`
                + ` WHERE ua.user_id = ? AND a.name = raw_mails.address`
                + `)`,
                params: [user_id],
            },
            await c.req.json().catch(() => null),
        );
        if (!result) return c.json({ error: "Invalid mail state request" }, 400);
        if (!result.success) return c.json(result, 500);
        return c.json(result);
    }
}
