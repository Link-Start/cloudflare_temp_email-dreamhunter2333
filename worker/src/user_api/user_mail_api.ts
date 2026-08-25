import { Context } from "hono";
import i18n from "../i18n";
import { handleMailListQuery } from "../common";
import { getBooleanValue } from "../utils";
import {
    getReadStatusQuery,
    applyMailReadStatusUpdate,
} from "../mail_flags";

export default {
    getMails: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address, limit, offset, read_status } = c.req.query();
        const filterQuerys = [`ua.user_id = ?`];
        const filterParams = [String(user_id)];
        if (address) {
            filterQuerys.push(`rm.address = ?`);
            filterParams.push(address);
        }
        const readStatusQuery = getReadStatusQuery(read_status, 'rm.flags');
        if (readStatusQuery === null) return c.json({ error: "Invalid mail read status filter" }, 400);
        if (readStatusQuery && !getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
            return c.json({ error: "Mail read status is disabled" }, 403);
        }
        if (readStatusQuery) {
            filterQuerys.push(readStatusQuery.clause);
            filterParams.push(...readStatusQuery.params);
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
    updateMailReadStatus: async (c: Context<HonoCustomType>) => {
        if (!getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
            return c.json({ error: "Mail read status is disabled" }, 403);
        }
        const { user_id } = c.get("userPayload");
        const result = await applyMailReadStatusUpdate(
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
        if (!result) return c.json({ error: "Invalid mail read status request" }, 400);
        if (!result.success) return c.json(result, 500);
        return c.json(result);
    }
}
