import { Context } from "hono";
import i18n from "../i18n";
import { handleMailListQuery } from "../common";
import { getBooleanValue } from "../utils";
import {
    getMailReadStatusUpdateExpression,
    parseMailReadStatusUpdate,
    parseReadStatusFilter,
    serializeMailState,
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
        const readStatusFilter = parseReadStatusFilter(read_status);
        if (readStatusFilter === null) return c.json({ error: "Invalid mail read status filter" }, 400);
        if (readStatusFilter && !getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
            return c.json({ error: "Mail read status is disabled" }, 403);
        }
        if (readStatusFilter) {
            filterQuerys.push(`(COALESCE(rm.flags, 0) & ?) ${readStatusFilter.state === 'set' ? '!=' : '='} 0`);
            filterParams.push(String(readStatusFilter.mask));
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
        const update = parseMailReadStatusUpdate(await c.req.json().catch(() => null));
        if (!update) return c.json({ error: "Invalid mail read status request" }, 400);

        const { user_id } = c.get("userPayload");
        const placeholders = update.ids.map(() => '?').join(',');
        const statusUpdate = getMailReadStatusUpdateExpression(update);
        const condition = statusUpdate.condition ? ` AND ${statusUpdate.condition}` : '';
        const result = await c.env.DB.prepare(
            `UPDATE raw_mails`
            + ` SET flags = ${statusUpdate.expression}`
            + ` WHERE id IN (${placeholders})`
            + ` AND EXISTS (`
            + `SELECT 1 FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` WHERE ua.user_id = ? AND a.name = raw_mails.address`
            + `)${condition}`
        ).bind(
            ...statusUpdate.params,
            ...update.ids,
            user_id,
            ...(statusUpdate.conditionParams ?? []),
        ).run();
        if (!result.success) return c.json({ success: false, changes: 0, results: [] }, 500);

        const { results } = await c.env.DB.prepare(
            `SELECT id, flags FROM raw_mails`
            + ` WHERE id IN (${placeholders})`
            + ` AND EXISTS (`
            + `SELECT 1 FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` WHERE ua.user_id = ? AND a.name = raw_mails.address`
            + `)`
        ).bind(...update.ids, user_id).all();
        return c.json({
            success: true,
            changes: result.meta.changes ?? 0,
            results: results.map(row => serializeMailState(row, true)),
        });
    }
}
