import { Context } from 'hono'

import i18n from '../i18n';
import { getBooleanValue } from '../utils';
import { handleMailListQuery, deleteAddressWithData, updateAddressUpdatedAt } from '../common'
import { resolveRawEmailRow } from '../gzip'
import { getSendBalanceState } from './send_balance';
import {
    getMailFlagUpdateExpression,
    parseMailFlagFilter,
    parseMailFlagUpdate,
    parseReadStatusFilter,
    serializeMailFlags,
} from '../mail_flags';

const listMails = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload")
    if (!address) {
        return c.json({ "error": "No address" }, 400)
    }
    const { limit, offset, flag, flag_state, read_status } = c.req.query();
    if (Number.parseInt(offset) <= 0) updateAddressUpdatedAt(c, address);
    if (read_status !== undefined && (flag !== undefined || flag_state !== undefined)) {
        return c.json({ error: "Conflicting mail flag filters" }, 400);
    }
    const flagFilter = read_status === undefined
        ? parseMailFlagFilter(flag, flag_state)
        : parseReadStatusFilter(read_status);
    if (flagFilter === null) return c.json({ error: "Invalid mail flag filter" }, 400);
    if (flagFilter && !getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
        return c.json({ error: "Mail flags are disabled" }, 403);
    }

    const filters = [`address = ?`];
    const params = [address];
    if (flagFilter) {
        filters.push(`(COALESCE(flags, 0) & ?) ${flagFilter.state === 'set' ? '!=' : '='} 0`);
        params.push(String(flagFilter.mask));
    }
    const whereClause = filters.join(' AND ');
    return await handleMailListQuery(c,
        `SELECT * FROM raw_mails WHERE ${whereClause}`,
        `SELECT count(*) as count FROM raw_mails WHERE ${whereClause}`,
        params, limit, offset
    );
};

const getMail = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload")
    const { mail_id } = c.req.param();
    const result = await c.env.DB.prepare(
        `SELECT * FROM raw_mails where id = ? and address = ?`
    ).bind(mail_id, address).first();
    if (!result) return c.json(null);
    const resolved = await resolveRawEmailRow(result);
    return c.json(serializeMailFlags(resolved, getBooleanValue(c.env.ENABLE_MAIL_FLAGS)));
};

const deleteMail = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { id } = c.req.param();
    // TODO: add toLowerCase() to handle old data
    const { success } = await c.env.DB.prepare(
        `DELETE FROM raw_mails WHERE address = ? and id = ? `
    ).bind(address.toLowerCase(), id).run();
    return c.json({ success });
};

const updateMailFlags = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.ENABLE_MAIL_FLAGS)) {
        return c.json({ error: "Mail flags are disabled" }, 403);
    }
    const update = parseMailFlagUpdate(await c.req.json().catch(() => null));
    if (!update) return c.json({ error: "Invalid mail flags request" }, 400);

    const { address } = c.get("jwtPayload");
    const placeholders = update.ids.map(() => '?').join(',');
    const flagUpdate = getMailFlagUpdateExpression(update);
    const condition = flagUpdate.condition ? ` AND ${flagUpdate.condition}` : '';
    const result = await c.env.DB.prepare(
        `UPDATE raw_mails`
        + ` SET flags = ${flagUpdate.expression}`
        + ` WHERE address = ? AND id IN (${placeholders})${condition}`
    ).bind(
        ...flagUpdate.params,
        address,
        ...update.ids,
        ...(flagUpdate.conditionParams ?? []),
    ).run();
    if (!result.success) return c.json({ success: false, changes: 0, results: [] }, 500);

    const { results } = await c.env.DB.prepare(
        `SELECT id, flags FROM raw_mails WHERE address = ? AND id IN (${placeholders})`
    ).bind(address, ...update.ids).all();
    return c.json({
        success: true,
        changes: result.meta.changes ?? 0,
        results: results.map(row => serializeMailFlags(row, true)),
    });
};

const getSettings = async (c: Context<HonoCustomType>) => {
    const { address, address_id } = c.get("jwtPayload")
    const msgs = i18n.getMessagesbyContext(c);
    if (address_id && address_id > 0) {
        try {
            const db_address_id = await c.env.DB.prepare(
                `SELECT id FROM address where id = ? `
            ).bind(address_id).first("id");
            if (!db_address_id) {
                return c.text(msgs.InvalidAddressMsg, 400)
            }
        } catch (error) {
            return c.text(msgs.InvalidAddressMsg, 400)
        }
    }
    try {
        if (!address_id) {
            const db_address_id = await c.env.DB.prepare(
                `SELECT id FROM address where name = ? `
            ).bind(address).first("id");
            if (!db_address_id) {
                return c.text(msgs.InvalidAddressMsg, 400)
            }
        }
    } catch (error) {
        return c.text(msgs.InvalidAddressMsg, 400)
    }

    updateAddressUpdatedAt(c, address);

    const { balance } = await getSendBalanceState(c, address);
    return c.json({
        address: address,
        send_balance: balance || 0,
    });
};

const deleteAddress = async (c: Context<HonoCustomType>) => {
    const { address, address_id } = c.get("jwtPayload")
    const success = await deleteAddressWithData(c, address, address_id);
    return c.json({ success });
};

const clearInbox = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { success } = await c.env.DB.prepare(
        `DELETE FROM raw_mails WHERE address = ?`
    ).bind(address).run();
    if (!success) {
        return c.text(msgs.FailedClearInboxMsg, 500)
    }
    return c.json({ success });
};

const clearSentItems = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { success } = await c.env.DB.prepare(
        `DELETE FROM sendbox WHERE address = ?`
    ).bind(address).run();
    if (!success) {
        return c.text(msgs.FailedClearSentItemsMsg, 500)
    }
    return c.json({ success });
};

export default {
    listMails, getMail, deleteMail, updateMailFlags,
    getSettings, deleteAddress, clearInbox, clearSentItems
};
